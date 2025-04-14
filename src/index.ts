import { redBright, greenBright } from "chalk";
import { getInput, getBooleanInput, setOutput } from "@actions/core";
import { exec } from "@actions/exec";
import { mkdirP, mv, rmRF, cp } from "@actions/io";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { saveCache, restoreCache } from "@actions/cache";
import { type } from "node:os";
import { glob } from "glob";
import { readFile } from "fs/promises";
import { createHash } from "crypto";

const paths = [
    "target/",
    "~/.cargo/bin/",
    "~/.cargo/registry/index/",
    "~/.cargo/registry/cache/",
    "~/.cargo/git/db/",
];

function trygetBooleanInput(n: string) {
    try {
        return getBooleanInput(n);
    } catch {
        return false;
    }
}

function error(msg: string) {
    console.error(`${redBright("ERROR")}: ${msg}`);
    return process.exit(1);
}

function info(msg: string) {
    console.log(`${greenBright("INFO")}: ${msg}`);
}

function splitArgs() {
    return getInput("package").split(",");
}

async function $(
    cmd: string,
    env: Record<string, string> | undefined = undefined,
    shell = false,
): Promise<undefined> {
    if (shell) {
        const cp = spawn(cmd, { stdio: "inherit", env, shell: true });
        return new Promise((resolve) => {
            cp.once("exit", (code) => {
                if (code !== 0) {
                    error(`command didn't exit successfully(${code}): ${cmd}`);
                }
                return resolve(undefined);
            });
        });
    }
    const code = await exec(cmd, undefined, {
        env,
    });
    if (code !== 0) {
        error(`command didn't exit successfully(${code}): ${cmd}`);
    }
    return undefined;
}

async function doInstallRust() {
    const doInstall = trygetBooleanInput("install-rustup");
    if (doInstall) {
        const output = "install-rust-arandompath.sh";
        await $(`curl https://sh.rustup.rs -o ${output}`);
        await $(`sh ${output} -y`);
        await $(`rm ${output}`);
    }
}

let openssl_dir: string | null = null;
let openssl_lib_dir: string | null = null;

async function doInstallOpenssl() {
    const base = resolve(process.env.GITHUB_WORKSPACE || __dirname);
    function path(j?: string) {
        if (j) {
            return join(base, "target", j);
        } else {
            return join(base, "target");
        }
    }
    const doInstall = trygetBooleanInput("install-openssl");
    if (doInstall) {
        if (!existsSync(path("openssl-aarch64"))) {
            await mkdirP(path());
            await $(
                "curl -O http://security.debian.org/debian-security/pool/updates/main/o/openssl/libssl-dev_1.1.1n-0+deb10u6_arm64.deb",
            );
            await $(
                "ar p libssl-dev_1.1.1n-0+deb10u6_arm64.deb data.tar.xz | tar Jxvf -",
                undefined,
                true,
            );
            await rmRF("libssl-dev_1.1.1n-0+deb10u6_arm64.deb");
            await mv("usr", path("openssl-aarch64"));
            await cp(
                path(
                    "openssl-aarch64/include/aarch64-linux-gnu/openssl/opensslconf.h",
                ),
                path("openssl-aarch64/include/openssl"),
            );
            info(`openssl installed`);
        }
        openssl_dir = path("openssl-aarch64");
        openssl_lib_dir = path("openssl-aarch64/lib/aarch64-linux-gnu");
    }
}
const restoreKeys = [`${type()}-CrossBuild-`];

async function main() {
    const willCache = getBooleanInput("cache");
    if (willCache) {
        const key = `${type()}-CrossBuild-${await hashFiles()}`;
        const cacheKey = await restoreCache(paths.slice(), key, restoreKeys);
        info(
            `restored cache with ${
                cacheKey ? `id ${cacheKey}` : "no cache hit"
            }`,
        );
        info(
            `primary key was: ${key}, additional keys were: ${restoreKeys.join(
                ",",
            )}`,
        );
    }
    await doInstallRust();
    await doInstallOpenssl();
    const packages = splitArgs();
    if (!packages.length) {
        return error("no build binary specified");
    }
    await $("sudo apt-get update");
    await $(
        "sudo apt-get install gcc-aarch64-linux-gnu gcc-x86-64-linux-gnu -y",
    );
    await $(
        "rustup target add aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu",
    );
    const nightly = trygetBooleanInput("nightly");
    if (nightly) {
        await $(`rustup install nightly`);
        await $(`rustup component add rust-src --toolchain nightly-x86_64-unknown-linux-gnu`);
        await $(`rustup component add rust-src --toolchain nightly-aarch64-unknown-linux-gnu`);
        await $(`rustup default nightly`);
    }
    for (const pkg of packages) {
        let env: Record<string, string> = process.env as Record<string, string>;
        if (openssl_dir && openssl_lib_dir) {
            env = {
                ...env,
                AARCH64_UNKNOWN_LINUX_GNU_OPENSSL_DIR: openssl_dir,
                AARCH64_UNKNOWN_LINUX_GNU_OPENSSL_LIB_DIR: openssl_lib_dir,
            };
        }
        if (willCache) {
            env = {
                ...env,
                CARGO_INCREMENTAL: "1",
            };
        }
        await $(
            `cargo build --target aarch64-unknown-linux-gnu --release --config target.aarch64-unknown-linux-gnu.linker='aarch64-linux-gnu-gcc' --package ${pkg}`,
            env,
        );
        await $(
            `cargo build --target x86_64-unknown-linux-gnu --release --config target.x86_64-unknown-linux-gnu.linker='x86_64-linux-gnu-gcc' --package ${pkg}`,
            env,
        );
    }
    await rmRF("./.out");
    await mkdirP("./.out");
    await mkdirP("./.out/aarch64");
    await mkdirP("./.out/x86-64");
    for (const pkg of packages) {
        await $(
            `aarch64-linux-gnu-strip target/aarch64-unknown-linux-gnu/release/${pkg} -o ./.out/aarch64/${pkg}`,
            undefined,
            true,
        );
        await $(
            `x86_64-linux-gnu-strip target/x86_64-unknown-linux-gnu/release/${pkg} -o ./.out/x86-64/${pkg}`,
            undefined,
            true,
        );
    }
    if (willCache) {
        const key = `${type()}-CrossBuild-${await hashFiles()}`;
        const _cacheId = await saveCache(paths.slice(), key);
    }
    const outResolved = resolve("./.out");
    setOutput("file", outResolved);
}

async function hashFiles() {
    const locks = await glob("**/Cargo.lock", { ignore: "target/**" });
    const hash = createHash("sha256");
    for (const path of locks) {
        const content = await readFile(path);
        hash.write(content);
    }
    return hash.digest("base64url");
}

main();

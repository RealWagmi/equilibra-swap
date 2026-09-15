// Write the exact verification inputs of the core contracts to
// artifacts/verify-inputs/ for manual submission through the explorer's
// "Verify & publish" form (Solidity, standard JSON input): one
// <Contract>.standard-input.json per contract, trimmed to its import
// closure, plus <Contract>.constructor-args.hex where the constructor
// takes arguments. Use it when the explorer's API is unreachable for
// scripts (Cloudflare challenge, rate limit) but works from a browser.
//
//   npm run deploy:verify-inputs --network=<hardhat-network>
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";

import {
  coreVerifyTargets,
  encodeConstructorArgs,
  explorerUrls,
  minimalStandardJsonInput,
  networkContext,
  readDeployments,
} from "./lib";

async function main() {
  const { chainId, isLocalDev, networkName } = await networkContext();
  if (isLocalDev) {
    console.log("Local dev chain — nothing to verify.");
    return;
  }
  const doc = readDeployments(networkName, chainId);
  if (!doc) {
    throw new Error(`No deployments document for '${networkName}' — run the core deploy first.`);
  }

  const outDir = path.join(__dirname, "..", "..", "artifacts", "verify-inputs", networkName);
  fs.mkdirSync(outDir, { recursive: true });

  const forms: string[] = [];
  const explorer = explorerUrls(networkName);

  for (const [label, address, constructorArguments, contract] of coreVerifyTargets(doc)) {
    const [sourceName, contractName] = contract.split(":");
    const buildInfo = await hre.artifacts.getBuildInfo(contract);
    if (!buildInfo) throw new Error(`no build info for ${contract} — compile first`);

    const inputPath = path.join(outDir, `${contractName}.standard-input.json`);
    fs.writeFileSync(inputPath, JSON.stringify(minimalStandardJsonInput(buildInfo.input, sourceName), null, 2));
    const args = await encodeConstructorArgs(contract, constructorArguments);
    const argsPath = path.join(outDir, `${contractName}.constructor-args.hex`);
    if (args) fs.writeFileSync(argsPath, args + "\n");
    else if (fs.existsSync(argsPath)) fs.unlinkSync(argsPath);

    console.log(`${label}`);
    console.log(`  address:          ${address}`);
    console.log(
      `  form:             ${explorer ? `${explorer.browserURL}/address/${address}/contract-verification` : "(no explorer configured)"}`
    );
    console.log(`  compiler:         v${buildInfo.solcLongVersion}`);
    console.log(`  contract name:    ${contractName}`);
    console.log(`  standard input:   ${inputPath}`);
    console.log(`  constructor args: ${args ? argsPath : "(none)"}`);

    if (explorer) {
      // One plain HTML form per contract: submitted by a real browser, so it
      // passes the explorer's bot protection; the explorer's JSON answer
      // (`{"status":"1","result":"<guid>"}`) opens in a new tab.
      const input = JSON.stringify(minimalStandardJsonInput(buildInfo.input, sourceName));
      const hidden = (name: string, value: string) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
      forms.push(
        `<form method="POST" action="${escapeHtml(explorer.apiURL)}" target="_blank">` +
          `<h2>${escapeHtml(label)}</h2><p><code>${address}</code></p>` +
          hidden("apikey", "empty") +
          hidden("module", "contract") +
          hidden("action", "verifysourcecode") +
          hidden("contractaddress", address) +
          hidden("codeformat", "solidity-standard-json-input") +
          hidden("contractname", contract) +
          hidden("compilerversion", `v${buildInfo.solcLongVersion}`) +
          hidden("constructorArguements", args) +
          `<textarea name="sourceCode" hidden>${escapeHtml(input)}</textarea>` +
          `<button type="submit">Submit ${escapeHtml(contractName)} to the explorer</button></form>`
      );
    }
  }

  if (forms.length > 0) {
    const htmlPath = path.join(outDir, "verify.html");
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><meta charset="utf-8"><title>Equilibra verification (${escapeHtml(networkName)})</title>` +
        `<style>body{font-family:sans-serif;max-width:60em;margin:2em auto}form{border:1px solid #ccc;padding:1em;margin:1em 0}</style>` +
        `<h1>Submit core contracts to ${escapeHtml(explorer!.apiURL)}</h1>` +
        `<p>Open this file in a normal browser, click one button at a time and wait for the new tab to show ` +
        `<code>"status":"1"</code>. Already verified contracts answer "already verified". Check progress with ` +
        `<code>npm run deploy:verify</code>, which skips verified contracts.</p>` +
        forms.join("\n")
    );
    console.log(`\nBrowser submission page: ${htmlPath}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

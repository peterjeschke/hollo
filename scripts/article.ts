#!/usr/bin/env tsx
/**
 * Hollo Article Publisher CLI
 *
 * Usage:
 *   tsx scripts/article.ts [options] [file.html]
 *   cat article.html | tsx scripts/article.ts [options]
 *
 * Options:
 *   --instance <url>       Hollo instance URL
 *   --login                Force re-authentication
 *   --title <text>         Article title (skips prompt)
 *   --language <code>      Language code, e.g. "en" (skips prompt)
 *   --visibility <v>       public|unlisted|private|direct (skips prompt)
 *   --sensitive            Mark article as sensitive (skips prompt)
 *   --yes                  Skip confirmation prompt
 *
 * Config is stored in ~/.config/hollo-cli/config.json
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createReadStream,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".config", "hollo-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
}

function loadConfig(): Partial<Config> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Partial<Config>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  htmlFile?: string;
  instanceUrl?: string;
  forceLogin: boolean;
  title?: string;
  language?: string;
  visibility?: string;
  sensitive?: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const result: Args = { forceLogin: false, yes: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--instance":
        result.instanceUrl = args[++i];
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--title":
        result.title = args[++i];
        break;
      case "--language":
        result.language = args[++i];
        break;
      case "--visibility":
        result.visibility = args[++i];
        break;
      case "--sensitive":
        result.sensitive = true;
        break;
      case "--yes":
        result.yes = true;
        break;
      default:
        if (!arg.startsWith("-")) result.htmlFile = arg;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Readline helpers — works even when stdin is piped (uses /dev/tty on Unix)
// ---------------------------------------------------------------------------

function openReadline() {
  // When stdin is piped (HTML coming from stdin), open /dev/tty so we can
  // still prompt the user interactively.
  const inputStream = (() => {
    if (!process.stdin.isTTY && process.platform !== "win32") {
      try {
        return createReadStream("/dev/tty");
      } catch {
        /* fall through */
      }
    }
    return process.stdin;
  })();

  return createInterface({ input: inputStream, output: process.stdout });
}

type Readline = ReturnType<typeof openReadline>;

async function prompt(rl: Readline, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

async function confirm(rl: Readline, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(rl, `${question} ${hint}: `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase() === "y";
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

async function registerApp(instanceUrl: string): Promise<{ clientId: string; clientSecret: string }> {
  const res = await fetch(`${instanceUrl}/api/v1/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Hollo Article CLI",
      redirect_uris: "urn:ietf:wg:oauth:2.0:oob",
      scopes: "write:statuses",
    }),
  });
  if (!res.ok) {
    throw new Error(`App registration failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { client_id: string; client_secret: string };
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

async function exchangeCode(
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${instanceUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      code,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function openBrowser(url: string): Promise<void> {
  try {
    const [bin, ...args] =
      process.platform === "darwin" ? ["open", url] :
      process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
      ["xdg-open", url];
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // silently ignore — URL is printed anyway
  }
}

async function authenticate(
  rl: Readline,
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
    scope: "write:statuses",
  });
  const authUrl = `${instanceUrl}/oauth/authorize?${params}`;

  console.log("\nOpening your browser for authorization...");
  console.log(`If it doesn't open automatically, visit:\n\n  ${authUrl}\n`);
  await openBrowser(authUrl);

  const code = await prompt(rl, "Paste the authorization code shown in the browser: ");
  if (!code) throw new Error("No authorization code provided.");

  return await exchangeCode(instanceUrl, clientId, clientSecret, code);
}

async function verifyToken(instanceUrl: string, accessToken: string): Promise<boolean> {
  const res = await fetch(`${instanceUrl}/api/v1/apps/verify_credentials`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Article API
// ---------------------------------------------------------------------------

interface ArticlePayload {
  summary: string;
  content_html: string;
  language?: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  sensitive: boolean;
}

interface PostResult {
  id: string;
  url: string;
  uri: string;
}

async function postArticle(
  instanceUrl: string,
  accessToken: string,
  payload: ArticlePayload,
): Promise<PostResult> {
  const res = await fetch(`${instanceUrl}/api/v1/articles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Failed to create article: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PostResult;
}

// ---------------------------------------------------------------------------
// HTML reading
// ---------------------------------------------------------------------------

async function readHtmlFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const stdinIsPiped = !process.stdin.isTTY;

  // Read HTML content first if it comes from stdin, before opening readline.
  let contentHtml: string | undefined;
  if (!args.htmlFile && stdinIsPiped) {
    process.stderr.write("Reading HTML from stdin...\n");
    contentHtml = await readHtmlFromStdin();
    process.stderr.write(`Read ${contentHtml.length} bytes.\n`);
  }

  const rl = openReadline();

  try {
    // -----------------------------------------------------------------------
    // 1. Instance URL
    // -----------------------------------------------------------------------
    const config = loadConfig();

    let instanceUrl = args.instanceUrl
      ?? config.instanceUrl
      ?? await prompt(rl, "Hollo instance URL (e.g. https://hollo.example.com): ");

    instanceUrl = instanceUrl.replace(/\/$/, "");

    if (!instanceUrl.startsWith("http")) {
      instanceUrl = `https://${instanceUrl}`;
    }

    // -----------------------------------------------------------------------
    // 2. OAuth — register app and get token
    // -----------------------------------------------------------------------
    let clientId = config.clientId;
    let clientSecret = config.clientSecret;

    // Re-register if switching instances
    if (!clientId || !clientSecret || config.instanceUrl !== instanceUrl) {
      process.stdout.write("Registering application with your instance... ");
      const app = await registerApp(instanceUrl);
      clientId = app.clientId;
      clientSecret = app.clientSecret;
      console.log("done.");
    }

    let accessToken = config.accessToken;

    if (
      args.forceLogin ||
      !accessToken ||
      config.instanceUrl !== instanceUrl ||
      !(await verifyToken(instanceUrl, accessToken))
    ) {
      console.log("Authentication required.");
      accessToken = await authenticate(rl, instanceUrl, clientId, clientSecret);
    }

    // Persist config
    saveConfig({ instanceUrl, clientId, clientSecret, accessToken });
    console.log(`Using instance: ${instanceUrl}`);

    // -----------------------------------------------------------------------
    // 3. HTML content
    // -----------------------------------------------------------------------
    if (contentHtml == null) {
      if (args.htmlFile) {
        if (!existsSync(args.htmlFile)) {
          throw new Error(`File not found: ${args.htmlFile}`);
        }
        contentHtml = await readFile(args.htmlFile, "utf-8");
        console.log(`Read ${contentHtml.length} bytes from ${args.htmlFile}.`);
      } else {
        const filePath = await prompt(rl, "Path to HTML file: ");
        if (!filePath) throw new Error("No HTML file provided.");
        contentHtml = await readFile(filePath, "utf-8");
        console.log(`Read ${contentHtml.length} bytes from ${filePath}.`);
      }
    }

    if (!contentHtml.trim()) {
      throw new Error("HTML content is empty.");
    }

    // -----------------------------------------------------------------------
    // 4. Article metadata
    // -----------------------------------------------------------------------
    console.log();

    const title =
      args.title
      ?? await prompt(rl, "Article title (required): ");
    if (!title) throw new Error("Title is required.");

    const languageInput =
      args.language
      ?? await prompt(rl, "Language code (e.g. en, de) [blank = account default]: ");
    const language = languageInput || undefined;

    const VISIBILITIES = ["public", "unlisted", "private", "direct"] as const;
    type Visibility = (typeof VISIBILITIES)[number];

    let visibility: Visibility = "public";
    if (args.visibility) {
      if (!VISIBILITIES.includes(args.visibility as Visibility)) {
        throw new Error(`Invalid visibility: ${args.visibility}. Must be one of: ${VISIBILITIES.join(", ")}`);
      }
      visibility = args.visibility as Visibility;
    } else {
      const visInput = await prompt(
        rl,
        `Visibility [${VISIBILITIES.join("/")}] (default: public): `,
      );
      if (visInput && VISIBILITIES.includes(visInput as Visibility)) {
        visibility = visInput as Visibility;
      } else if (visInput) {
        throw new Error(`Invalid visibility: ${visInput}`);
      }
    }

    const sensitive =
      args.sensitive
      ?? await confirm(rl, "Mark as sensitive?", false);

    // -----------------------------------------------------------------------
    // 5. Confirm and publish
    // -----------------------------------------------------------------------
    console.log(`
--- Article preview ---
Title:      ${title}
Language:   ${language ?? "(account default)"}
Visibility: ${visibility}
Sensitive:  ${sensitive}
HTML size:  ${contentHtml.length} bytes
-----------------------`);

    const ok = args.yes || await confirm(rl, "\nPublish?", true);
    if (!ok) {
      console.log("Aborted.");
      process.exitCode = 0;
      return;
    }

    process.stdout.write("Publishing... ");
    const post = await postArticle(instanceUrl, accessToken, {
      summary: title,
      content_html: contentHtml,
      language,
      visibility,
      sensitive,
    });

    console.log("done!\n");
    console.log(`ID:  ${post.id}`);
    console.log(`URL: ${post.url}`);
    console.log(`IRI: ${post.uri}`);
  } finally {
    rl.close();
  }
}

main().catch((err: Error) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

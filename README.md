<div align="center">

# 🎨 ChatGPT Images MCP

**Generate images from Claude Code or Codex with your own signed-in ChatGPT account.**<br>
No OpenAI API key needed.

[![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/download)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![MCP server](https://img.shields.io/badge/MCP-server-6E56CF)](https://modelcontextprotocol.io)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-D97757)](https://code.claude.com/docs/en/setup)
[![Codex](https://img.shields.io/badge/Codex-supported-111111)](https://learn.chatgpt.com/docs/cli)
[![OpenAI API key](https://img.shields.io/badge/OpenAI%20API%20key-not%20needed-2ea44f)](#-quick-start)

[🚀 Quick start](#-quick-start) · [🎨 Using it](#-using-it) · [👥 Accounts](#-multiple-accounts) · [🔧 Configuration](#-configuration) · [🩺 Troubleshooting](#-troubleshooting) · [📖 Commands](#-command-reference)

</div>

---

```text
🤖 Your agent  ──▶  🧩 MCP server  ──▶  🌐 Chrome  ──▶  💬 chatgpt.com  ──▶  🖼️ Image saved locally
```

- 🤝 Works with **Claude Code**, **Codex**, or both
- 📎 Up to **4 reference images** per request
- 📚 **Batches** of up to 25 prompts
- 📐 **Aspect ratios** like `1:1`, `3:4`, `16:9`
- 👥 **Multiple accounts** with automatic switching at image limits
- 🔒 Everything stays **on your computer**

## 📋 Requirements

🟢 [Node.js 22+](https://nodejs.org/en/download) · 🌐 [Google Chrome](https://www.google.com/chrome/) · 💬 A ChatGPT account · 🤖 [Claude Code](https://code.claude.com/docs/en/setup) and/or [Codex](https://learn.chatgpt.com/docs/cli)

## 🚀 Quick start

### Option A: one command (recommended)

```sh
npx -y chatgpt-images-mcp@latest init
```

Signs in your ChatGPT account and connects Claude Code and Codex for you.

### Option B: connect by hand

**1. Add the server to your agent**

```sh
# Claude Code
claude mcp add --scope user chatgpt-images -- npx -y chatgpt-images-mcp@latest

# Codex
codex mcp add chatgpt-images -- npx -y chatgpt-images-mcp@latest
```

**2. Sign in to ChatGPT**

```sh
npx chatgpt-images-mcp manage-accounts
```

Choose **+ Add an account** → **Sign in with Chrome**.

### ✅ Try it

Restart Claude Code or Codex, then ask:

> Use chatgpt-images to generate a watercolor fox beneath an oak tree, 1:1, and show me the result.

> [!TIP]
> Something not working? Run `npx chatgpt-images-mcp doctor`. It prints a fix for each problem.

## 🎨 Using it

Just ask your agent, for example:

> *"Generate a hero image for the landing page and save it to public/hero.webp."*

Images take a few minutes. Chrome runs in the background and closes when the queue is empty.

### 📎 Reference images

Up to **4** PNG, JPEG or WebP files (max 20 MB each), as absolute paths:

```json
{
  "prompt": "Paint this cabin as a watercolor.",
  "aspect_ratio": "3:4",
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

### 📚 Batches

Up to **25 prompts** in one ChatGPT conversation:

```json
{
  "prompts": ["A cabin at sunrise", "The same cabin at night"],
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

Add `"same_chat_mandatory": true` to keep every image in a single conversation.

## 👥 Multiple accounts

```sh
npx chatgpt-images-mcp manage-accounts
```

```text
◆  ChatGPT accounts · the top one is used first; the next takes over at an image limit
│  ● you@example.com  Plus · --account main
│      ready · expires in 12 days · 42 images (6 in last 24h) · used 2h ago
│  ○ work@example.com  Free · --account work
│      image limit · available Sat 14:30 · 9 images (9 in last 24h) · used 5h ago
│  ○ + Add an account
│  ○ Exit
```

- 🥇 The **top account** is used first.
- 🔀 At an image limit, the job **moves to the next account** and the old one rests for 24 hours.
- 🎯 Timeouts never trigger a switch, so a prompt is **never sent twice**.

## 🔐 Other ways to sign in

<details>
<summary>🍪 <b>Paste session cookies</b> (when Google blocks sign-in)</summary>

<br>

1. In your normal Chrome, open [chatgpt.com](https://chatgpt.com/) and sign in.
2. Open DevTools (<kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>I</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>) → **Application** → **Cookies** → `https://chatgpt.com`.
3. Copy the values of `__Secure-next-auth.session-token.0` and `.1`.
4. Run `npx chatgpt-images-mcp manage-accounts` → select the account → **Paste session cookies instead**.

> [!WARNING]
> These cookies give full access to your ChatGPT account. Never share or commit them.

</details>

<details>
<summary>📄 <b>Import a JSON cookie export</b></summary>

<br>

```sh
npx chatgpt-images-mcp import-cookies --account main --file "/absolute/path/to/cookies.json"
```

Accepts a JSON cookie array or a Playwright storage-state file.

</details>

## 🔧 Configuration

Optional. Put settings in `~/.chatgpt-images-mcp/.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_AUTO_SWITCH_ACCOUNTS` | `true` | Switch accounts at image limits |
| `CHATGPT_TIMEOUT_MS` | `300000` | Max wait per image |
| `CHATGPT_BROWSER_FOCUS` | `background` | `front` brings Chrome forward on each send |
| `CHATGPT_DATA_DIR` | `~/.chatgpt-images-mcp/data` | Where data is stored |

<details>
<summary>🛠️ <b>Advanced settings</b></summary>

<br>

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_MANUAL_CLOSE_MS` | `10000` | How long normal Chrome stays open for verification |
| `CHATGPT_BROWSER_MODE` | `cdp` | `cdp` (your Chrome), `playwright` or `webkit` |
| `CHATGPT_HEADLESS` | `false` | Hide the browser (`playwright`/`webkit` only) |
| `CHATGPT_CHROME_EXECUTABLE` | auto | Custom Chrome path |
| `CHATGPT_POLL_MS` | `2000` | Progress check interval |
| `CHATGPT_COOKIES_FILE` | unset | Cookie export applied on each launch |
| `CHATGPT_BROWSER_CHANNEL` | unset | Browser channel (`playwright` only) |

CSS selector overrides for when ChatGPT's layout changes are listed in [.env.example](.env.example).

</details>

## 📁 Your data

Everything lives in `~/.chatgpt-images-mcp/`: accounts, Chrome profiles, jobs, images and `worker.log`.

> [!CAUTION]
> This folder holds your session secrets. Don't share or commit it.

## 🔄 Updating

Automatic. `@latest` picks up new releases; just restart Claude Code or Codex.

## 🩺 Troubleshooting

```sh
npx chatgpt-images-mcp doctor
```

Fixes most problems. For details on a request, see `~/.chatgpt-images-mcp/data/worker.log`.

<details>
<summary>🔒 <b>"Data directory is in use"</b></summary>

<br>

Close all Claude Code and Codex sessions, wait a few seconds, then retry. Don't delete lock files.

</details>

<details>
<summary>🔌 <b>Server doesn't connect or shows "0 tools"</b></summary>

<br>

Run `npx chatgpt-images-mcp@latest doctor` once to finish the download, then restart your agent.

</details>

<details>
<summary>🤖 <b>Verification check keeps appearing</b></summary>

<br>

`manage-accounts` → select the account → **Sign in again with Chrome**. Still stuck? Close your agents and run:

```sh
npx chatgpt-images-mcp browser-manual --account main
```

</details>

<details>
<summary>🔑 <b>Status is <code>login_required</code></b></summary>

<br>

Session expired. `manage-accounts` → select the account → **Sign in again with Chrome**.

</details>

<details>
<summary>⏳ <b>Status is <code>usage_limit</code> or <code>blocked</code></b></summary>

<br>

Image limit reached; the account is back after 24 hours (`retryAfter`). Add another account to keep going.

</details>

<details>
<summary>🖼️ <b>Image finished in ChatGPT but the job failed</b></summary>

<br>

```sh
npx chatgpt-images-mcp recover --job JOB_ID
```

</details>

<details>
<summary>🚫 <b>Codex says "approval policy is never"</b></summary>

<br>

Add this to `~/.codex/config.toml`, then restart Codex:

```toml
[mcp_servers.chatgpt-images]
default_tools_approval_mode = "approve"
```

</details>

## 📖 Command reference

All commands start with `npx chatgpt-images-mcp`.

| Command | What it does |
| --- | --- |
| 🏁 `init` | Guided setup |
| 🩺 `doctor` | Check setup and suggest fixes |
| 🧹 `cleanup [--images-older-than DAYS]` | Free disk space |
| 👥 `manage-accounts` | Add, sign in, reorder or delete accounts |
| 📋 `accounts` | List accounts as JSON |
| 🍪 `paste-cookies --account NAME` | Paste session cookies |
| 📄 `import-cookies --account NAME --file PATH` | Import a cookie file |
| 📶 `status --account NAME` | Live session check |
| 🎨 `generate --prompt "…"` | Generate from the terminal |
| 🛟 `recover --job JOB_ID` | Save an image from a failed job |
| 🌐 `browser-manual --account NAME` | Open normal Chrome for verification |
| ❓ `--help` | Show every command |

## 🧰 MCP tools

| Tool | Purpose |
| --- | --- |
| `generate_image` | Queue one image |
| `generate_images` | Queue 1–25 prompts |
| `wait_for_job` | Wait for a job to finish |
| `get_image` | Get the file path and a preview |
| `save_image` | Copy an image into your project |
| `get_job_status` · `get_batch_status` | Check progress |
| `list_jobs` · `cancel_job` | Manage jobs |
| `session_status` · `list_accounts` · `add_account` | Manage accounts |

## 💻 Development

<details>
<summary>Install from source</summary>

<br>

```sh
git clone https://github.com/meet244/ChatGPT-Images-MCP.git
cd ChatGPT-Images-MCP
npm ci
npm run cli -- init
```

```sh
npm run check       # type-check
npm test            # test suite (needs: npx playwright install chromium webkit)
npm run test:live   # one real image request (uses your quota)
```

To release, bump `version`, update [CHANGELOG.md](CHANGELOG.md), tag, push, then `npm publish`.

</details>

## 📝 Notes

- 🧩 Automates the ChatGPT website, so layout changes may need an update.
- ⚖️ Follow OpenAI's terms; normal image limits apply.
- 🏠 Runs locally over stdio, with no public network endpoint.

## 📄 License

[MIT](LICENSE) © 2026 Meet Patel

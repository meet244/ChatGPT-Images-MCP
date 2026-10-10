# ChatGPT Images MCP

Generate images from **Claude Code** or **Codex** using your own signed-in ChatGPT account. You don't need an OpenAI API key.

This is a local [MCP](https://modelcontextprotocol.io) server. When your coding agent asks for an image, the server opens a dedicated Google Chrome profile, sends the prompt (and optional reference images) to chatgpt.com, waits for the result, and saves the image on your computer.

- Works with Claude Code, Codex, or both at once.
- Supports reference images, batches of up to 25 prompts, and aspect ratios.
- Supports several ChatGPT accounts, switching automatically when one hits its image limit.
- Normal ChatGPT image limits still apply.

## Requirements

- [Node.js](https://nodejs.org/en/download) **22 or newer** (includes `npm` and `npx`)
- [Google Chrome](https://www.google.com/chrome/)
- [Git](https://git-scm.com/downloads), which npm uses to download this project from GitHub
- A ChatGPT account that can generate images
- [Claude Code](https://code.claude.com/docs/en/setup) and/or [Codex](https://learn.chatgpt.com/docs/cli)

You don't need to clone the repository: `npx` downloads and builds it for you.

## Quick start

### 1. Add your ChatGPT account

```sh
npx -y github:meet244/ChatGPT-Images-MCP manage-accounts
```

The first run downloads and builds the project, which takes up to a minute. Then:

1. Choose **`1) Add account and paste cookies`**.
2. Enter a profile name, such as `main`.
3. Paste the two session-cookie values when asked. See [Finding your session cookies](#finding-your-session-cookies).
4. Chrome opens twice, first normally and then under the server's control. If ChatGPT shows a verification check, complete it. Each window closes on its own after about 10 seconds.
5. Wait until the terminal prints **`ready: ChatGPT is ready to receive image requests…`**, then choose **`0`** to exit.

If it prints `challenge` or `login_required` instead, see [Troubleshooting](#troubleshooting).

### 2. Connect your coding agent

**Claude Code:**

```sh
claude mcp add --scope user chatgpt-images -- npx -y github:meet244/ChatGPT-Images-MCP
```

**Codex:**

```sh
codex mcp add chatgpt-images -- npx -y github:meet244/ChatGPT-Images-MCP
```

Register the server once. It handles every account you add. Restart any Claude Code or Codex sessions that were already open, then type `/mcp` in the session to confirm that `chatgpt-images` is connected.

### 3. Generate an image

Ask your agent:

> Use chatgpt-images to generate a watercolor image of a fox beneath an oak tree, aspect ratio 1:1, then show me the finished image.

The image is saved on your computer, and the agent gets its file path and a preview.

### Optional: a shorter command

The rest of this guide writes terminal commands as `chatgpt-images-mcp <command>`. To make that work, add this alias to your `~/.zshrc` or `~/.bashrc`:

```sh
alias chatgpt-images-mcp='npx -y github:meet244/ChatGPT-Images-MCP'
```

Without the alias, type `npx -y github:meet244/ChatGPT-Images-MCP` in place of `chatgpt-images-mcp`.

## Finding your session cookies

Use your everyday Chrome browser, where you normally sign in:

1. Open [chatgpt.com](https://chatgpt.com/) and sign in to the account you want to connect.
2. Open DevTools: **Cmd + Option + I** on macOS, or **Ctrl + Shift + I** on Windows/Linux.
3. Go to the **Application** tab, then **Storage → Cookies → `https://chatgpt.com`**.
4. Filter for `session-token` and copy the full **Value** of each cookie:

| Order | Cookie name |
| --- | --- |
| First | `__Secure-next-auth.session-token.0` |
| Second | `__Secure-next-auth.session-token.1` |

When the terminal asks for each one, paste **only the value**: no quotes, no `name=`, and no commas. Both values must come from the same signed-in session. Long values can look cut off in the table, so copy from the value viewer below it.

> [!WARNING]
> These cookies give full access to your ChatGPT session. Paste them only into your own terminal, and keep them out of screenshots, chats, and Git commits. Pasted input is visible on screen.

**If you don't see exactly `.0` and `.1`:** some sessions use one unsplit token or more parts. Use [browser sign-in or a JSON cookie export](#other-ways-to-sign-in) instead. Don't make up a missing part.

## Using it

Your agent handles this automatically. For reference, the tools work like this:

1. `generate_image` queues the request and returns a job ID straight away.
2. The server uploads any references, sends the prompt to ChatGPT, and clicks **Send exactly once**.
3. `wait_for_job` waits up to 25 seconds per call. While the job is `queued` or `running`, the agent calls it again with the same ID.
4. `get_image` returns the saved file path and a preview.

An image can take a few minutes; the default timeout is 5 minutes. Keep the dedicated Chrome window open while it works. The server closes it once the queue is empty.

### Reference images

Pass up to **4** PNG, JPEG, or WebP files as absolute paths. Each can be at most 20 MB and 40 megapixels.

```json
{
  "prompt": "Paint this cabin as a watercolor, keeping its shape and snowy setting.",
  "aspect_ratio": "3:4",
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

The aspect ratio is a request inside the prompt. The server doesn't crop the image to enforce it.

### Batches

`generate_images` accepts **1–25 prompts**. They run in order in one ChatGPT conversation, sharing the same references:

```json
{
  "prompts": ["A cabin at sunrise", "The same cabin at night"],
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

If an account runs out of image quota partway through, the finished images are kept and the remaining prompts continue on another account. Set `"same_chat_mandatory": true` if every image must come from a single conversation. A switch then restarts the whole batch from the first prompt on the new account. Check `get_batch_status` until the whole batch reports `completed` before treating those results as final.

## Multiple accounts and automatic switching

Add as many ChatGPT accounts as you like. Each one has its own cookies, Chrome profile, job history, images, and cooldown. Manage them all from one menu:

```sh
chatgpt-images-mcp manage-accounts
```

The menu can add an account, replace its cookies, rename it, set its priority, pick one manually, close its Chrome window, or delete it.

- **Higher priority numbers run first.** Each new account gets the current highest priority + 1.
- **Switching is automatic.** When ChatGPT reports an image limit, the server puts that account on a **24-hour cooldown** and continues the same job on the next ready account. Two image-less text replies in a row on the same account also count as a likely limit.
- **Only definite limits trigger a switch.** Timeouts and unclear failures stop the job instead, so a prompt is never sent twice.
- **Job IDs stay the same after a switch**, so your agent keeps polling the same ID.

To turn switching off, set `CHATGPT_AUTO_SWITCH_ACCOUNTS=false` (see [Configuration](#configuration)).

Inside your agent, `list_accounts` shows your profiles and `add_account` creates an empty one. Signing in always happens in your terminal, so cookie values never pass through the agent.

## Other ways to sign in

**Sign in in the browser** instead of pasting cookies:

```sh
chatgpt-images-mcp setup --account main
```

Choose **1) Log in / open browser**, sign in in the Chrome window, then press Enter in the terminal.

**Import a JSON cookie export.** This works with an unsplit token or a full export from a cookie extension:

```sh
chatgpt-images-mcp import-cookies --account main --file "/absolute/path/to/cookies.json"
```

The file can be a JSON array of cookies or a Playwright storage-state file.

## Configuration

The defaults work for most people. To change a setting, create `~/.chatgpt-images-mcp/.env`:

```dotenv
CHATGPT_AUTO_SWITCH_ACCOUNTS=true
CHATGPT_TIMEOUT_MS=300000
```

You can also pass settings when you register the server, for example `claude mcp add --scope user -e CHATGPT_TIMEOUT_MS=600000 chatgpt-images -- npx -y github:meet244/ChatGPT-Images-MCP`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_AUTO_SWITCH_ACCOUNTS` | `true` | Move a job to another ready account when one hits its image limit. |
| `CHATGPT_TIMEOUT_MS` | `300000` | Longest wait for one image, in milliseconds. |
| `CHATGPT_MANUAL_CLOSE_MS` | `10000` | How long each setup Chrome window stays open for verification. `0` waits until you quit Chrome yourself. |
| `CHATGPT_BROWSER_MODE` | `cdp` | `cdp` uses your installed Chrome. Alternatives are `playwright` and `webkit` (see below). |
| `CHATGPT_HEADLESS` | `false` | Hide the browser. Works only in `playwright` or `webkit` mode. |
| `CHATGPT_CHROME_EXECUTABLE` | auto-detected | Path to Chrome if it's installed somewhere unusual. |
| `CHATGPT_DATA_DIR` | `~/.chatgpt-images-mcp/data` | Where sessions, jobs, and images are stored. |
| `CHATGPT_POLL_MS` | `2000` | How often the browser is checked for progress. |
| `CHATGPT_COOKIES_FILE` | unset | A cookie export reapplied on every browser launch. Prefer `import-cookies`. |
| `CHATGPT_BROWSER_CHANNEL` | unset | Browser channel for `playwright` mode only. |

If ChatGPT's page layout changes, you can override the CSS selectors the server uses. The variables are `CHATGPT_COMPOSER_SELECTOR`, `CHATGPT_SEND_SELECTOR`, `CHATGPT_ASSISTANT_SELECTOR`, `CHATGPT_IMAGE_SELECTOR`, `CHATGPT_FILE_INPUT_SELECTOR`, `CHATGPT_ATTACHMENT_PREVIEW_SELECTOR`, and `CHATGPT_UPLOAD_PROGRESS_SELECTOR`. Their defaults are in [.env.example](.env.example). Relative paths in `.env` resolve from `~/.chatgpt-images-mcp`.

**Alternative browsers.** To use Playwright's own Chromium or WebKit instead of your installed Chrome, install the engine with `npx playwright install chromium` (or `webkit`). Then set `CHATGPT_BROWSER_MODE=playwright` (or `webkit`). The two-window verification step during setup is Chrome-only.

## Where your data lives

Everything stays on your computer in `~/.chatgpt-images-mcp/`:

```text
~/.chatgpt-images-mcp/
  .env                        Your optional settings
  data/
    account-settings.json     Account names, priorities, selection mode
    accounts/<name>/
      chrome-profile/         That account's dedicated Chrome profile
      jobs.sqlite             Prompts, job status, cooldowns
      images/<job-id>/        Generated images
      references/             Private copies of your reference images
    worker.log                Server diagnostics
```

The folder is private (`700`) and holds your session secrets, so don't share it or commit it.

## Updating

When you start a new agent session, `npx` checks GitHub and installs the latest version automatically. Your accounts and images are kept, because they live outside the package.

After an update, close **all** Claude Code and Codex sessions so the old background server exits, then open them again.

To stay on a fixed version, add a tag or commit to the package name, such as `github:meet244/ChatGPT-Images-MCP#<tag-or-commit>`, everywhere you use it.

## Troubleshooting

**"This data directory is in use by another server or login command"**
A running server, or another setup command, is using that account. Close every Claude Code and Codex session, including IDE extensions, and wait a few seconds for the background server to exit. A server with queued images exits once they finish. Then run your command again. Don't delete lock files or change `CHATGPT_DATA_DIR` to work around this.

**The server doesn't connect, or shows "0 tools"**
The first launch, and the first launch after an update, has to download and build the project. That can be slower than your agent's startup timeout. Run `chatgpt-images-mcp accounts` once in a terminal to finish the install, then restart your agent. The server needs internet access when it starts because `npx` checks GitHub. Run `claude mcp get chatgpt-images` or `codex mcp list` to check the registration.

**Status is `challenge` (verification keeps appearing)**
Close your agent sessions, then open the account's profile in normal Chrome and complete the check:

```sh
chatgpt-images-mcp browser-manual --account main
```

Quit that Chrome window completely, then check again with `chatgpt-images-mcp status --account main`.

**Status is `login_required`**
The session has expired. Paste fresh cookies with `chatgpt-images-mcp manage-accounts`, option **2**.

**Status is `usage_limit` or `blocked`**
That account's image limit was reached. It's on a 24-hour cooldown, shown as `retryAfter`. Add another account to keep generating in the meantime.

**The image finished in ChatGPT, but the job failed or timed out**
Close your agent sessions, then save the image from the existing conversation without sending a new prompt:

```sh
chatgpt-images-mcp recover --job JOB_ID
```

**Codex says "approval policy is never"**
Codex blocked the tool call. To let this server's tools run without prompting, add `default_tools_approval_mode = "approve"` under `[mcp_servers.chatgpt-images]` in `~/.codex/config.toml`, then restart Codex.

## Command reference

| Command | What it does |
| --- | --- |
| `chatgpt-images-mcp manage-accounts` | Interactive menu: add accounts, paste cookies, rename, set priority, select, delete. |
| `chatgpt-images-mcp accounts` | List accounts as JSON, without opening a browser. |
| `chatgpt-images-mcp setup --account NAME` | Check the session, then sign in through the browser or paste cookies. |
| `chatgpt-images-mcp paste-cookies --account NAME` | Paste the `.0` and `.1` cookie values for an existing account. |
| `chatgpt-images-mcp import-cookies --account NAME --file PATH` | Import a JSON cookie export. |
| `chatgpt-images-mcp account-add --account NAME` | Create an empty account profile. |
| `chatgpt-images-mcp account-use --account NAME` | Always prefer this account; undo with menu option 6. |
| `chatgpt-images-mcp status --account NAME` | Run a live session check in the browser. |
| `chatgpt-images-mcp generate --prompt "…" [--reference PATH]` | Generate one image directly from the terminal. |
| `chatgpt-images-mcp recover --job JOB_ID` | Save a finished image from a failed job's conversation. |
| `chatgpt-images-mcp browser-manual --account NAME` | Open the account's profile in normal Chrome to complete verification. |
| `chatgpt-images-mcp browser-close --account NAME` | Close the account's dedicated Chrome. |
| `chatgpt-images-mcp config` | Print an MCP client config with absolute paths. |
| `chatgpt-images-mcp --help` | Show every command. |

Commands that use a browser need the account to be free, so close your agent sessions first. Without `--account`, a command uses the currently selected account.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `session_status` | Quick readiness check based on saved cookies and cooldowns. Doesn't open a browser. |
| `generate_image` | Queue one image. Takes `prompt`, plus optional `reference_images` and `aspect_ratio`. |
| `generate_images` | Queue 1–25 prompts as a batch. Takes optional `same_chat_mandatory`. |
| `wait_for_job` | Wait up to 25 seconds for a job to finish. |
| `get_job_status` | Read a job's current status. |
| `get_batch_status` | Read a batch's status and each of its jobs. |
| `get_image` | Get a finished image's file path and a preview of up to 1024 px. |
| `list_jobs` | List recent jobs across all accounts. |
| `cancel_job` | Cancel a job that hasn't started yet. |
| `list_accounts` | List account profiles and which one is selected. |
| `add_account` | Create an empty account profile. Sign in from the terminal afterwards. |

One background server is shared by every connected agent. Jobs run one at a time, with up to 25 waiting. Queued jobs survive restarts and keep running after your agent disconnects. A job that was mid-generation when the server stopped is marked failed, never resent, so it can't use your quota twice.

## Install from source

For development, or if you prefer a fixed local copy:

```sh
git clone https://github.com/meet244/ChatGPT-Images-MCP.git
cd ChatGPT-Images-MCP
npm ci      # also builds dist/
npm link    # makes the chatgpt-images-mcp command available
```

Register it with `claude mcp add --scope user chatgpt-images -- chatgpt-images-mcp`, or the same arguments after `codex mcp add`. A source install keeps its settings in the project folder (`.env`, copied from `.env.example`) and its data in `.chatgpt-images/`. To update, run `git pull && npm ci`, then restart your agents.

**Already set up from a clone and moving to `npx`?** Keep your existing accounts by pointing the new install at the old data. Add `CHATGPT_DATA_DIR=/absolute/path/to/ChatGPT-Images-MCP/.chatgpt-images` to `~/.chatgpt-images-mcp/.env`.

### Development

```sh
npm run check   # type-check
npm test        # full test suite, headless; needs Chrome plus: npx playwright install chromium webkit
npm run test:live   # one real image request through ChatGPT (uses your quota)
```

Tests use local fixture pages and fake sessions, so they don't use any ChatGPT image quota.

## Notes

- This project automates the ChatGPT website. When ChatGPT changes its page layout, the server may need an update or selector overrides.
- Your use must follow OpenAI's terms. Image limits and content policies work exactly as they do on chatgpt.com.
- The server talks to your agent over local stdio only. It doesn't expose a public network endpoint.

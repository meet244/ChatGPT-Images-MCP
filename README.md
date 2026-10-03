# ChatGPT Images MCP

Generate images from **Claude Code** or **Codex** through your signed-in ChatGPT browser session. This local MCP integration opens a dedicated Google Chrome profile, submits your image prompt and optional reference images, and saves the result on your computer.

**Supported clients: Claude Code and Codex.** You can connect either client or both to the same installation. This server uses ChatGPT's website and does not require an OpenAI API key. Your coding client still needs its own login or configuration.

## Setup order

1. [Install the project](#1-install-the-project).
2. [Connect your first ChatGPT account](#2-connect-your-first-chatgpt-account).
3. Finish browser verification and wait for the terminal to report `ready`.
4. Register the integration in [Claude Code](#3-connect-claude-code) or [Codex](#4-connect-codex).
5. [Generate your first image](#5-generate-your-first-image).

Complete account setup **before opening the MCP connection**. This avoids the profile-lock error when importing cookies.

## 1. Install the project

You need:

- [Node.js](https://nodejs.org/en/download) **22 or newer**, with npm.
- [Google Chrome](https://www.google.com/chrome/) installed locally.
- [Git](https://git-scm.com/downloads).
- A ChatGPT account with access to image generation.
- Claude Code or Codex; installation commands are below.

The shell examples below use macOS/Linux `bash` or `zsh`. Run the browser and MCP server on the same computer as your client.

Check Node and npm:

```sh
node --version
npm --version
```

Download and build the integration:

```sh
git clone https://github.com/meet244/ChatGPT-Images-MCP.git
cd ChatGPT-Images-MCP
npm ci
npm run build
cp .env.example .env
```

For a fresh installation, keep the default browser settings in `.env`:

```dotenv
CHATGPT_BROWSER_MODE=cdp
CHATGPT_HEADLESS=false
```

This mode uses your installed Google Chrome with a separate profile. You do not need to install a Chrome extension or download a Playwright browser for the default setup. Keep the project folder at its installed path: client registration will point to its built `dist/index.js` file.

If the project is already installed, use that folder and preserve its `.env` and `.chatgpt-images` directory. See [Updating](#updating) instead of cloning again.

## 2. Connect your first ChatGPT account

Your first account is called **`default`**. It already exists; do not run `account:add` for it. The explicit `--account default` commands below also work if a different account was previously selected.

### A. Find the two session-cookie values

Use your everyday Chrome browser, where you can sign in normally:

1. Open [chatgpt.com](https://chatgpt.com/) and sign in to the ChatGPT account you want to connect.
2. Wait until the signed-in ChatGPT page loads.
3. Open Chrome DevTools: **Command + Option + I** on macOS, or **Ctrl + Shift + I** on Windows/Linux. You can also right-click the page and select **Inspect**.
4. Open the **Application** tab. If it is hidden, look in the DevTools tab overflow menu.
5. In the left sidebar, expand **Storage → Cookies** and select **`https://chatgpt.com`**.
6. Filter for `session-token` and find these exact cookie names:

| Order | Cookie name | What to copy |
| --- | --- | --- |
| First | `__Secure-next-auth.session-token.0` | Its complete **Value** |
| Second | `__Secure-next-auth.session-token.1` | Its complete **Value** |

Select each cookie to see its value; copy the full value from the **Value** cell or value viewer. A long value may look truncated in the table, so make sure you copy the whole token part. Both parts must come from the **same signed-in account and session**.

Chrome's [official cookie inspection guide](https://developer.chrome.com/docs/devtools/application/cookies) explains the Application → Storage → Cookies panel.

These cookies grant access to your session. Paste them only into the local terminal prompts below. Input is visible, so keep it out of screenshots, shared terminals, chat messages, and Git commits.

**If you cannot find exactly `.0` and `.1`:** confirm that you are signed in and have selected the ChatGPT cookie origin. Some sessions use an unsplit token or a different number of parts. Use [browser login or JSON import](#browser-login-or-json-import) for those sessions; do not invent a missing part or paste a different cookie in its place.

### B. Paste the values into the terminal

Keep Claude Code and Codex MCP connections closed during first-account setup. From the project folder, run:

```sh
npm run paste-cookies -- --account default
```

The terminal asks for the first cookie:

```text
__Secure-next-auth.session-token.0:
```

Paste **only its value**, then press **Enter**. Next it asks for:

```text
__Secure-next-auth.session-token.1:
```

Paste **only that value**, then press **Enter** again.

The names are already supplied. You do not need quotes, `name=value`, commas, a cookie-file path, or an `END` line. Input remains visible. Both values are collected before importing; **Ctrl+C** cancels entry.

### C. Wait for ordinary Chrome, then complete verification

After both values are entered, the command prepares the dedicated profile and opens **ordinary Chrome first**. Keep the terminal command running.

1. Wait for ChatGPT to finish loading in the newly opened window. Loading and verification may take some time; there is no fixed delay you must count down.
2. Complete any verification shown in that window.
3. Confirm that your account is signed in and the ChatGPT message box is available.
4. **Fully quit that account's dedicated Chrome instance.** On macOS, closing its window with the red button can leave Chrome running; use **Google Chrome → Quit Google Chrome** from that instance's menu so the process exits.
5. The terminal automatically starts **controlled Chrome** with the same profile and checks the session. Wait for this handoff to finish.

You may see:

```text
Saved 2 cookies. Ordinary Chrome is open for this account.
Manual Chrome closed. Reconnecting controlled Chrome using the same account profile…
```

The terminal waits for ordinary Chrome to exit. If it appears to be waiting after you close the window, check whether that dedicated Chrome process is still running. No extra Enter or separate `browser:manual` command is needed for this cookie-import handoff.

Finish only when the result contains:

```json
{
  "status": "ready",
  "message": "ChatGPT is ready to receive image requests. Account access and image usage limits still apply."
}
```

If the status is `challenge`, `login_required`, or `unavailable`, resolve it using [Troubleshooting](#troubleshooting) before generating images. A saved cookie alone does not confirm that the browser is ready.

### D. Select and check the first account

After the cookie command finishes, run:

```sh
npm run account:use -- --account default
npm run status -- --account default
npm run accounts
```

Check that `status` reports `ready` and `accounts` shows `default` as active with `has_saved_session: true`. Then register your client below. Once a client is connected, use its MCP `session_status` tool for checks; terminal session commands need the profile lock to be free.

### Browser login or JSON import

If you prefer signing in directly, run this **instead of cookie pasting**:

```sh
npm run setup -- --account default
```

Choose **1) Log in / open browser**, sign in or complete verification in the visible browser, then press Enter in the terminal when asked. Choose **2) Paste cookies** to use the two-value workflow above. A working saved session is reused without asking you to sign in again.

For an unsplit token, additional token parts, or a complete cookie export, import an exported JSON file:

```sh
npm run import-cookies -- --account default --file "/absolute/path/to/cookies.json"
```

The importer accepts a JSON cookie array or a Playwright storage-state object containing `cookies`. It imports unexpired ChatGPT/OpenAI-domain cookies; storage-state `origins` are not imported. The export must include the complete session token. In default Chrome mode, this command follows the same ordinary-Chrome-first verification and automatic handoff.

## 3. Connect Claude Code

### Install the Claude Code CLI

If `claude --version` already works, skip installation. Otherwise, use Anthropic's [official installer](https://code.claude.com/docs/en/setup):

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new terminal after installation and check:

```sh
claude --version
```

### Register this MCP server

Change into the project folder. Replace this example path with the folder you actually installed:

```sh
cd "/absolute/path/to/ChatGPT-Images-MCP"
```

Then register it:

```sh
claude mcp add --scope user --transport stdio chatgpt-images -- \
  "$(command -v node)" \
  "$PWD/dist/index.js" serve
```

Check registration:

```sh
claude mcp get chatgpt-images
```

Start a new Claude Code session:

```sh
claude
```

Follow Claude Code's own sign-in prompts if needed. Inside its interactive session, enter `/mcp` and confirm that `chatgpt-images` is connected. Restart any sessions that were already open when you registered the server. Claude Code may ask you to approve tool use according to your permission settings.

`--scope user` makes this integration available across your projects. Both executable and server paths are captured as absolute paths, including when the project folder contains spaces. See Anthropic's [official MCP configuration documentation](https://code.claude.com/docs/en/mcp).

## 4. Connect Codex

### Install the Codex CLI

If `codex --version` already works, skip installation. Otherwise, use the installer in the [official OpenAI Codex CLI documentation](https://learn.chatgpt.com/docs/cli):

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Open a new terminal and check:

```sh
codex --version
```

If you installed Codex through npm instead and your shell cannot find it, expose your npm global executables in the current terminal:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
```

### Register this MCP server

Change into the installed project folder:

```sh
cd "/absolute/path/to/ChatGPT-Images-MCP"
```

Then register and check it:

```sh
codex mcp add chatgpt-images -- \
  "$(command -v node)" \
  "$PWD/dist/index.js" serve

codex mcp list
```

Start a new Codex session:

```sh
codex
```

Follow Codex's own sign-in prompts if needed. In the Codex terminal UI, enter `/mcp` and check the active connection. Restart an already running Codex client or IDE extension to load the new configuration. See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

Signing in to Codex does not import cookies into this integration; the ChatGPT account setup in step 2 is still required.

### Optional: image generation without approval prompts

If you want these two generation tools to run without prompting, add the following to `~/.codex/config.toml` and restart Codex:

```toml
[mcp_servers.chatgpt-images.tools.generate_image]
approval_mode = "approve"

[mcp_servers.chatgpt-images.tools.generate_images]
approval_mode = "approve"
```

This allows those tools to submit prompts and reference images to ChatGPT without an approval prompt. Other tools keep their existing permission settings. If these tables already exist, edit their `approval_mode` entries rather than adding duplicate tables. See [OpenAI's per-tool approval settings](https://learn.chatgpt.com/docs/extend/mcp).

## 5. Generate your first image

Ask Claude Code or Codex:

> Use chatgpt-images to check session_status for account default. If it is ready, generate one watercolor image of a fox beneath an oak tree, with aspect_ratio "1:1". Wait for the returned job ID and show the finished image.

The integration exposes **12 tools**. Your client starts the local server connection automatically; you do not need to run `npm start` separately.

Generation is asynchronous:

1. `generate_image` returns a job ID after queue admission.
2. The worker uploads references, fills the prompt, activates its ChatGPT tab, and clicks Send once.
3. `wait_for_job` waits up to **25 seconds** per call. If the job is still `queued` or `running`, wait again using the **same job ID**.
4. When the job completes, the client can show the preview and the saved image path.

An image may take longer than a single wait call. The default generation timeout is **5 minutes**, configurable in `.env`. Do not submit the same prompt again just because a wait returned before completion. Keep the dedicated Chrome window open while work is running.

Saved images are under `.chatgpt-images/images/<job-id>/` for `default`, or `.chatgpt-images/accounts/<name>/images/<job-id>/` for a named account. Previews fit within 1024 × 1024; the saved image retains the downloaded bytes. Image dimensions depend on ChatGPT's result. The aspect ratio is requested in the prompt, not enforced by cropping.

### Reference images and batches

Provide absolute local file paths for references. Up to **4 static PNG, JPEG, or WebP files**, each at most **20 MB** and **40 megapixels**, are accepted. ChatGPT can impose additional limits.

Example `generate_image` arguments:

```json
{
  "account": "default",
  "prompt": "Paint this cabin as a watercolor, keeping its shape and snowy setting.",
  "aspect_ratio": "3:4",
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

For a batch, call `generate_images` with **1–25 prompts**:

```json
{
  "prompts": ["A cabin at sunrise", "The same cabin at night"],
  "different_chat": false,
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

By default, prompts continue in the same chat and reuse its original references. Set `different_chat: true` for a new chat and reference upload per prompt. Poll `get_batch_status` with the batch ID, or use `wait_for_job` with each individual job ID. A failure stops the remaining batch jobs and retains completed images.

## Add and switch accounts

There is no fixed two-account limit. Each named profile has its own cookies, browser storage, jobs, images, and cooldown. Profile names are local labels, not verified email addresses.

**Set up a new account before selecting it.** Run these steps separately so you can complete the interactive cookie command before proceeding.

Create the second profile:

```sh
npm run account:add -- --account second
```

Sign in to that ChatGPT account in your everyday browser and copy its cookie values. Import them into the new profile:

```sh
npm run paste-cookies -- --account second
```

Finish ordinary Chrome verification and the controlled-browser handoff. Once it reports `ready`, select it:

```sh
npm run account:use -- --account second
npm run accounts
```

For another account, repeat those steps with `third`, `work`, or another name. Names must start with a lowercase letter and contain 1–48 lowercase letters, digits, underscores, or hyphens. If a profile already exists, skip `account:add` and finish its setup.

To return to your first account:

```sh
npm run account:use -- --account default
```

Inside Claude Code or Codex, you can use `list_accounts` and `use_account`, or supply `account` explicitly to an image tool. Account selection persists across restarts and is shared by all clients. It affects new requests; existing jobs stay with the account that started them. Job and batch lookups infer their original account from the ID.

You register the MCP server **once**, not once per account. `serve` does not accept an `--account` argument. Accounts are selected explicitly; usage-limit failures do not automatically switch accounts or replay prompts.

If a worker has already opened the profile you want to sign in to, disconnect all MCP clients and let accepted jobs finish before running its terminal setup. See the lock error below.

## Troubleshooting

### “This data directory is in use by another server or login command”

The profile is locked by an MCP worker or an ongoing setup command.

1. Disconnect every Claude Code/Codex session using this installation, including background or IDE sessions.
2. Stop any standalone `npm start`, login, or setup process you launched; use Ctrl+C in its terminal. Let accepted generation jobs finish before stopping their worker.
3. Wait for the worker to exit and release its locks. An idle worker normally exits about one second after its last client disconnects; accepted jobs keep it alive until they finish.
4. Run the cookie command again, replacing `default` with the account you are setting up:

```sh
npm run paste-cookies -- --account default
```

Reconnect clients after setup finishes. Do not delete an active lock or change `CHATGPT_DATA_DIR` merely to work around it: that would select different session storage. A new unused account can be set up while other accounts are active, but a worker that has opened that new profile holds its lock too.

### “MCP tool call requires approval, but approval policy is never”

The client blocked the tool before it reached this server. `never` prevents approval prompts; it does not approve tools that require approval. Use interactive approval settings, or deliberately configure the two generation tools as described in [the Codex approval section](#optional-image-generation-without-approval-prompts), then restart the client.

### Chrome opens, but verification keeps repeating

Keep saved cookies and disconnect MCP clients. Open the account's profile in ordinary Chrome:

```sh
npm run browser:manual -- --account default
```

Let ChatGPT load and complete verification. This diagnostic command also opens Cloudflare's compatibility checker. Fully quit that dedicated instance, then check readiness:

```sh
npm run status -- --account default
```

Unlike cookie import, standalone `browser:manual` does not automatically reconnect controlled Chrome after exit; the `status` command reconnects it. Browser verification must be completed normally. See [Cloudflare's troubleshooting guidance](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/) if ordinary Chrome also fails.

### `login_required`, `challenge`, or `unavailable`

| Status | Next step |
| --- | --- |
| `login_required` | Sign in or import fresh cookies for that account. |
| `challenge` | Complete browser verification; retain the existing cookies. |
| `unavailable` | Wait for the page to load, check your network, and retry the session check. If it persists, update the adapter or its selectors. |
| `busy` | A generation is running. Wait on its existing job ID. |
| `usage_limit` | Wait until the returned `retryAfter`; see usage limits below. |

For a disconnected client's profile, check again with:

```sh
npm run status -- --account default
```

While the MCP worker owns a profile, use the MCP `session_status` tool instead.

### The prompt is filled, but not sent

Update and rebuild the project, then reconnect all MCP clients. The worker activates its ChatGPT tab immediately before Send so a background tab cannot stall the click's animation-frame checks. Keep dedicated Chrome open and finish any attachment uploads or verification.

Submission failures now identify whether Send never became ready, the click failed, or ChatGPT did not confirm acceptance. Check the draft and conversation before retrying. Ambiguous failures are not automatically resent.

### Image limits and failed requests

ChatGPT image limits still apply. A recognized image-limit failure starts this server's persisted **24-hour cooldown for that account**. `session_status` returns `usage_limit`; new generation calls return `blocked` with `errorCode`, `detectedAt`, and `retryAfter` without sending a prompt.

The website's displayed reset text is retained as `limitReset`; it is separate from the server's 24-hour retry policy. Restarting does not clear the cooldown. Completed images remain available, and failed requests are not automatically replayed.

If ChatGPT finished an image but the job failed or timed out, disconnect MCP clients, let other jobs finish, and recover the saved conversation:

```sh
npm run recover -- --job JOB_ID
```

Recovery requires a failed/interrupted job with a recorded conversation URL. It saves existing generated images without sending a new prompt and infers the account from the job ID.

### Server missing, “0 tools,” or an old tool list

Run registration from the repository folder so `$PWD/dist/index.js` points to this server. Confirm it exists with:

```sh
npm run build
```

After an update, disconnect **all** clients so the old shared worker exits, then restart/reconnect them. Restarting only one client can leave it attached to an older worker still held open by another session. Expect **12 tools**. Use `claude mcp get chatgpt-images` or `codex mcp list` to check configuration. Re-register if you moved the project folder.

## Updating

Finish accepted image jobs, disconnect all clients, then run from the project folder:

```sh
git pull
npm ci
npm run build
```

Keep your existing `.env` and `.chatgpt-images` directory. Restart clients afterward so the updated worker is loaded.

## Command reference

Session/browser commands accept `--account NAME`; without it they use the selected account. Use the explicit flag when setting up your first account. Run interactive commands separately rather than pasting a whole sequence into a terminal waiting for cookie values.

| Command | Purpose |
| --- | --- |
| `npm run setup -- --account default` | Check the session; choose browser login or cookies when signed out. |
| `npm run paste-cookies -- --account default` | Enter visible `.0` and `.1` values, then run manual-first verification. |
| `npm run import-cookies -- --account default --file "/path/cookies.json"` | Import a complete JSON cookie export. |
| `npm run login -- --account default` | Open controlled Chrome; sign in, then press Enter to save. |
| `npm run status -- --account default` | Check the browser session; requires a free profile lock. |
| `npm run accounts` | List profiles and the selected account without opening Chrome. |
| `npm run account:add -- --account second` | Create an empty named profile. |
| `npm run account:use -- --account second` | Select an account for new requests. |
| `npm run browser -- --account default` | Open/reuse dedicated controlled Chrome. |
| `npm run browser:manual -- --account default` | Open ordinary Chrome for manual diagnostics. |
| `npm run browser:close -- --account default` | Close that account's dedicated controlled Chrome. |
| `npm run recover -- --job JOB_ID` | Recover images from an existing failed job's conversation. |
| `node dist/index.js config` | Print MCP configuration with absolute paths. |
| `node dist/index.js generate --account default --prompt "A watercolor fox"` | Generate directly from the terminal. |

A direct reference-image request looks like:

```sh
node dist/index.js generate --account default \
  --prompt "Paint this cabin as a watercolor" \
  --reference "/absolute/path/to/cabin.png"
```

For a real MCP smoke test, disconnect clients and finish existing jobs first, then run:

```sh
npm run test:live
```

This submits **one real ChatGPT image request**, waits for it, retrieves the saved file, and prints its dimensions and conversation URL. Optional arguments are `--prompt "Your description"` and repeatable `--reference "/absolute/path/to/image.png"`.

## MCP tool reference

| Tool | Purpose |
| --- | --- |
| `session_status` | Check the selected/explicit account's browser readiness or cooldown. |
| `generate_image` | Queue one image; accepts `prompt`, optional `reference_images`, and `aspect_ratio`. |
| `generate_images` | Queue 1–25 prompts; accepts shared references, ratio, and optional `different_chat`. |
| `wait_for_job` | Wait 0–25 seconds for an existing job; optionally return an image preview. |
| `get_job_status` | Read one job's status, errors, conversation URL, and image paths. |
| `get_batch_status` | Read batch progress and jobs. |
| `get_image` | Retrieve a completed job's image metadata and optional preview. |
| `list_jobs` | List recent jobs for one account; optional `limit` defaults to 20. |
| `cancel_job` | Cancel a queued job; running jobs cannot be cancelled through MCP. |
| `list_accounts` | List profiles, selection, and whether session cookies are saved. |
| `add_account` | Create an empty profile; authenticate privately in the terminal/browser. |
| `use_account` | Select the shared default account for new requests. |

All image/job tools accept optional `account`. Job/batch lookups infer ownership from the ID when it is omitted. `wait_for_job` requires an individual `job_id`; `get_batch_status` requires `batch_id`. Retrieval tools accept `image_index` (default 0) and `include_preview` (default true).

One shared local worker serves both clients. Each account has its own FIFO queue, with up to 25 waiting jobs. Accepted work continues after clients disconnect. Queued jobs survive restarts; interrupted running jobs become failed, and remaining jobs in their batches stop. No uncertain prompt is automatically resubmitted. Only an explicit conversation-length rejection permits one automatic rollover to a new chat with the original references.

## Configuration and local storage

See [.env.example](.env.example). The server loads `.env` from the project directory regardless of the client's working directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_DATA_DIR` | `.chatgpt-images` | Session, profile, jobs, references, and images. |
| `CHATGPT_BROWSER_MODE` | `cdp` | Installed Chrome; alternatives: `playwright` or `webkit`. |
| `CHATGPT_HEADLESS` | `false` | Visible browser; headless is available in alternative modes. |
| `CHATGPT_CHROME_EXECUTABLE` | Auto-detected | Path to a nonstandard Chrome installation. |
| `CHATGPT_COOKIES_FILE` | Unset | Optional JSON export reapplied on controlled browser launches. |
| `CHATGPT_BROWSER_CHANNEL` | Unset | Channel for Playwright-managed Chromium only. |
| `CHATGPT_TIMEOUT_MS` | `300000` | Maximum wait for an image generation. |
| `CHATGPT_POLL_MS` | `2000` | Browser polling interval. |
| `CHATGPT_COMPOSER_SELECTOR` | Built-in | Override the prompt editor selector. |
| `CHATGPT_SEND_SELECTOR` | Built-in | Override Send. |
| `CHATGPT_ASSISTANT_SELECTOR` | Built-in | Override assistant-message detection. |
| `CHATGPT_IMAGE_SELECTOR` | `img` | Override image selection within assistant turns. |
| `CHATGPT_FILE_INPUT_SELECTOR` | Built-in | Override the reference upload input. |
| `CHATGPT_ATTACHMENT_PREVIEW_SELECTOR` | Built-in | Override uploaded-reference previews. |
| `CHATGPT_UPLOAD_PROGRESS_SELECTOR` | Built-in | Override upload-progress detection. |

Prefer a one-time CLI import over `CHATGPT_COOKIES_FILE`. If that variable is configured, unset it after importing so future launches do not reapply an older export. Relative environment paths resolve from the project directory; CLI `--file` paths resolve from your terminal's working directory.

```text
.chatgpt-images/
  session-cookies.json      Private cookie snapshot for default
  chrome-profile/           Dedicated installed Chrome profile
  jobs.sqlite               Prompts, statuses, cooldown, and image metadata
  active-account.json       Selected profile
  references/               Private copies of reference images
  images/<job-id>/           Generated images
  worker.json               Private endpoint while the shared worker runs
  worker.log                Worker diagnostics
  accounts/<name>/          Each named profile's own session, browser, jobs and files
```

Cookies and browser profiles contain authentication secrets; prompts and conversation URLs are stored in the job database. Session files use private permissions and are gitignored. Keep custom data directories and cookie exports outside version control too.

The client connection uses local stdio. The private localhost worker connection is internal; it is not a public HTTP MCP endpoint. Dedicated editing tools and full-resolution download-button support are not implemented. ChatGPT website changes can require adapter updates.

### Alternative browser engines

The default installed-Chrome mode is recommended for this setup guide. To use managed Chromium, install it and set `CHATGPT_BROWSER_MODE=playwright` in `.env`:

```sh
npm run browser:install
```

For Playwright WebKit, install it and set `CHATGPT_BROWSER_MODE=webkit`:

```sh
npm run browser:install:webkit
```

These modes use separate profiles, import cookies directly, and close their browser when the command/server exits. WebKit is Playwright's build, not your installed Safari profile. The manual-first workflow and `browser:manual` command are Chrome-specific. No browser mode guarantees that a ChatGPT verification challenge will accept the session.

## Development

Install the test browser engines, then run the checks:

```sh
npm run browser:install
npm run browser:install:webkit
npm run check
npm test
```

Tests cover MCP connections, per-account isolation and locks, sequential visible cookie entry, manual Chrome handoff, uploads, background-tab submission, single/batch generation, bounded waits, image retrieval, restart recovery, and persisted cooldowns. Browser fixtures use local pages and fake sessions; they do not consume ChatGPT image usage. The default CDP tests also need installed Google Chrome.

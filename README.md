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

New installations start with **no accounts**. Run `npm run accounts:manage` and choose **1) Add account and paste cookies** to choose your own profile ID and connect it. No `default` account is created automatically.

For the separate commands in this guide, explicitly create the example profile first:

```sh
npm run account:add -- --account default
```

You can use a different profile ID in all the commands below. Existing saved sessions and image history from older installations remain available as `default` until you delete that account.

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

1. Wait for ChatGPT to load and complete any verification in the newly opened window.
2. The command automatically closes this account’s ordinary verification Chrome after **10 seconds**. You can fully quit that dedicated Chrome sooner.
3. The terminal starts **controlled Chrome** with the same profile and waits another **10 seconds** before checking the session, saving the login, and closing controlled Chrome. Complete any verification in this second window too. The MCP reopens this profile when needed.

You may see:

```text
Saved 2 cookies. Ordinary Chrome is open for this account.
Manual Chrome closed. Reconnecting controlled Chrome using the same account profile…
Session browser closed. The saved login is retained; the MCP will reopen the browser when needed.
```

No extra Enter or separate `browser:manual` command is needed. For more verification time, set `CHATGPT_MANUAL_CLOSE_MS=120000` in `.env` for two minutes in each window, or `0` to wait until you fully quit the first dedicated Chrome manually (the second window still gets 10 seconds). Quitting the first window early does not shorten the second window’s wait. Both setup browser stages close automatically after their work finishes; everyday Chrome is untouched.

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
npm run status -- --account default
npm run accounts
```

Check that `status` reports `ready` and `accounts` shows `default` with `has_saved_session: true`. Then register your client below. Once a client is connected, use its parameterless MCP `session_status` tool for checks; terminal session commands need the profile lock to be free.

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

### Optional: MCP tools without approval prompts

If you want all tools in this MCP to run without prompting, add `default_tools_approval_mode = "approve"` to the existing `[mcp_servers.chatgpt-images]` table in `~/.codex/config.toml`, alongside its `command` and `args`, then restart Codex:

```toml
[mcp_servers.chatgpt-images]
# Keep your existing command and args here.
default_tools_approval_mode = "approve"
```

This approves all 11 tools, including `session_status`, account switching, and image generation. Edit the existing table instead of adding a duplicate. Per-tool `approval_mode` settings override this default; existing generation entries set to `"approve"` can remain. See [OpenAI's MCP approval settings](https://learn.chatgpt.com/docs/extend/mcp).

## 5. Generate your first image

Ask Claude Code or Codex:

> Use chatgpt-images to check session_status. If it is ready, generate one watercolor image of a fox beneath an oak tree, with aspect_ratio "1:1". Wait for the returned job ID and show the finished image.

The integration exposes **11 tools**. Your client starts the local server connection automatically; you do not need to run `npm start` separately.

Generation is asynchronous:

1. `generate_image` returns a job ID after queue admission.
2. The worker uploads references, fills the prompt, activates its ChatGPT tab, and clicks Send once.
3. `wait_for_job` waits up to **25 seconds** per call. If the job is still `queued` or `running`, wait again using the **same job ID**.
4. When the job completes, call `get_image` to retrieve its saved path and optional preview.

An image may take longer than a single wait call. The default generation timeout is **5 minutes**, configurable in `.env`. Do not submit the same prompt again just because a wait returned before completion. Keep the dedicated Chrome window open while work is running.

Saved images are under `.chatgpt-images/images/<job-id>/` for `default`, or `.chatgpt-images/accounts/<name>/images/<job-id>/` for a named account. Previews fit within 1024 × 1024; the saved image retains the downloaded bytes. Image dimensions depend on ChatGPT's result. The aspect ratio is requested in the prompt, not enforced by cropping.

### Reference images and batches

Provide absolute local file paths for references. Up to **4 static PNG, JPEG, or WebP files**, each at most **20 MB** and **40 megapixels**, are accepted. ChatGPT can impose additional limits.

Example `generate_image` arguments:

```json
{
  "prompt": "Paint this cabin as a watercolor, keeping its shape and snowy setting.",
  "aspect_ratio": "3:4",
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

For a batch, call `generate_images` with **1–25 prompts**:

```json
{
  "prompts": ["A cabin at sunrise", "The same cabin at night"],
  "same_chat_mandatory": false,
  "reference_images": ["/absolute/path/to/cabin.png"]
}
```

By default, prompts continue in the same chat and reuse its original references. Account failover behaves the same with or without references: completed images are kept, and only the remaining prompts continue on another account.

Set `same_chat_mandatory: true` when every image must be generated in one conversation:

```json
{
  "prompts": ["First image", "Second image", "Third image"],
  "same_chat_mandatory": true
}
```

If the quota runs out after two images, the default `same_chat_mandatory: false` keeps those two and generates only the third on the replacement account. With `true`, the worker reruns all three prompts from the beginning in one new chat on that account. Original references, if supplied, are re-uploaded. Job and batch IDs remain unchanged. The worker retains earlier attempts and image paths internally. Existing image files are preserved. Another confirmed quota limit can restart the batch again on another untried eligible account.

`same_chat_mandatory: true` disables conversation-length rollover: a conversation-full rejection stops the mandatory batch, so its results never span multiple chats. Uncertain failures never trigger a restart. Mandatory batches reserve their queue capacity until completion so a full replay fits.

Poll `get_batch_status` with the batch ID, or use `wait_for_job` with each individual job ID. For a mandatory batch, wait until the **whole batch** reports `completed` before treating its images as final: earlier completed jobs can return to `queued` during a restart. If no fallback is available or another failure occurs, remaining jobs stop and partial results remain available.

## Add accounts and automatic switching

There is no fixed two-account limit. Each profile has its own cookies, browser storage, jobs, images, and cooldown. Manage them interactively from the project directory:

```sh
npm run accounts:manage
```

The menu lets you add accounts with the existing two-cookie paste flow, replace cookies, rename display names, set priorities, select an account manually, return to automatic priority order, close an account’s controlled Chrome, or choose **8) Delete an account**. Choose an account number or profile ID; deletion requires typing the profile ID to confirm. It removes that account’s saved cookies, browser profile, jobs, and images. Copies saved elsewhere remain available. Deleting the selected account restores automatic selection; deleting the last account leaves an empty list. No default account is automatically created or recreated. An existing legacy `default` account can also be deleted without deleting other accounts or shared settings.

Metadata changes work while the worker is running and apply to new requests; cookie, browser, and deletion operations require that profile’s runtime lock to be free. Disconnect MCP clients and finish login/setup commands before deleting an account held by the worker.

**Higher priority numbers run first:** `2` before `1`. Each new account receives the current maximum priority **+ 1**, so it runs first in automatic mode once authenticated. Existing saved priorities are retained; profiles without a saved priority default to `100`. Automatic priority order is the default mode. Accounts without saved cookies are skipped for initial selection when signed-in profiles exist. Equal priorities prefer the last used account, then sort by profile ID. Quota failover tries ready profiles in this same priority order; exhausted profiles retain their cooldown. When a higher-preference account’s cooldown expires, new requests can use it again.

Manual selection overrides priorities for new requests until you choose **Use automatic priority order**. Quota fallback still works and visits the remaining accounts in priority order. Editing priorities does not disable an existing manual override. Existing jobs and batches keep their original continuity and restart rules.

Renaming changes the display name, including for `default`; the underlying profile ID stays fixed. Cookies, conversations, job ownership, and saved image paths remain linked. Commands using `--account` continue to use the profile ID shown in brackets. Settings are stored privately in `account-settings.json`; no cookie values are stored there.

The separate commands below remain available.

**Finish signing in to each new profile before the server can use it.** Run these steps separately so you can complete the interactive cookie command before proceeding.

Create the second profile:

```sh
npm run account:add -- --account second
```

Sign in to that ChatGPT account in your everyday browser and copy its cookie values. Import them into the new profile:

```sh
npm run paste-cookies -- --account second
```

Finish ordinary Chrome verification and the controlled-browser handoff. Once it reports `ready`, the profile is eligible for automatic selection. Check your connected profiles:

```sh
npm run accounts
```

For another account, repeat those steps with `third`, `work`, or another name. Names must start with a lowercase letter and contain 1–48 lowercase letters, digits, underscores, or hyphens. If a profile already exists, skip `account:add` and finish its setup.

Inside Claude Code or Codex, use `list_accounts` to inspect profiles and `add_account` to create an empty profile. The server handles account selection and failover; generation, session, and job tools do not accept an `account` parameter. Job and batch lookups infer the owning profile from their IDs. `list_jobs` returns recent history across all profiles.

You register the MCP server **once**, not once per account. `serve` does not accept an `--account` argument. Automatic account switching is **enabled by default** for `generate_image` and `generate_images`. When ChatGPT confirms an image usage limit, the worker saves that profile's cooldown, selects another ready signed-in profile, and continues the same job. New requests follow the configured priority order or manual selection, skipping saved quota cooldowns.

For automatic generation failover, only profiles with saved sessions that pass a readiness check are eligible. Empty, signed-out, challenged, locked, or cooling-down profiles are skipped. Each eligible profile is tried at most once per job. If none is available, the job fails with the saved limit details; remaining batch jobs stop and completed images are retained. Two consecutive completed text-only responses without an image on the same profile are treated as an **assumed image limit**, even without an explicit quota notice. The first text-only response fails its request without resubmitting it. The second saves the existing 24-hour cooldown and, when switching is enabled, continues that current request on a ready fallback. The streak is persisted per executing profile across requests and worker restarts; a successful image or a different generation failure resets it. After the cooldown expires, counting starts over. Earlier failed or cancelled requests are not replayed. This is a fallback heuristic: text-only replies can also be refusals or other responses, so they do not prove the quota is exhausted. Timeouts, uncertain submissions, and other errors never trigger account switching.

To disable automatic switching globally, set `CHATGPT_AUTO_SWITCH_ACCOUNTS=false` in `.env` and restart your MCP clients and worker.

Job and batch IDs keep their original owning account, so keep polling the same IDs after a switch. Account routing and attempt history remain internal and are omitted from tool responses. Images are saved under the generating profile. A batch starts a new chat after switching and re-uploads its original reference snapshots; subsequent prompts continue in that new chat. By default it keeps completed images; `same_chat_mandatory: true` restarts the entire batch in the new chat. Earlier chat messages are not transferred between accounts.

`recover --job JOB_ID` also uses the recorded execution profile when recovering a failed job's existing image, while keeping its metadata in the original owning profile. Both profiles must be free of runtime locks.

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

The client blocked the tool before it reached this server. `never` prevents approval prompts; it does not approve tools that require approval. To automatically approve this MCP's tools, set `default_tools_approval_mode = "approve"` as described in [the Codex approval section](#optional-mcp-tools-without-approval-prompts), then restart the client. Approving only `generate_image` and `generate_images` leaves tools such as `session_status` subject to their existing approval settings.

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

ChatGPT image limits still apply. A recognized image-limit failure starts this server's persisted **24-hour cooldown for that account**. `session_status` automatically switches from an exhausted profile to a ready fallback and returns the replacement account’s state. If saved, non-exhausted profiles exist but none is currently ready, it selects one and returns its actual `challenge`, `login_required`, or `unavailable` state, keeping the selected browser available for recovery. A profile in use returns `busy`; unreadable session data returns `unavailable`. These conditions do not become the exhausted account’s old usage-limit response. Status calls also return `busy` promptly while generation is running. Generation also skips exhausted profiles. Disabled switching or no available fallback return `blocked` with a concise `error` and `retryAfter` without queuing a new job.

The website's displayed reset text is retained internally as `limitReset`; it is separate from the server's 24-hour retry policy. Restarting does not clear the cooldown. Completed images remain available, and failed requests are not automatically replayed.

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

After an update, disconnect **all** clients so the old shared worker exits, then restart/reconnect them. Restarting only one client can leave it attached to an older worker still held open by another session. Expect **11 tools**. Use `claude mcp get chatgpt-images` or `codex mcp list` to check configuration. Re-register if you moved the project folder.

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
| `npm run accounts:manage` | Interactive account menu: cookies, display names, priorities, selection, and browser close. |
| `npm run accounts` | List profile IDs, display names, priorities, selection mode, and saved-session availability as JSON. |
| `npm run account:add -- --account second` | Create an empty named profile. |
| `npm run account:use -- --account second` | Enable manual selection; return to priority mode through the interactive menu. |
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

This runs headlessly and submits **one real ChatGPT image request**, waits for it, retrieves the saved file, and prints its path and dimensions. Before starting, it closes existing dedicated account browsers so it can reopen them headlessly with their saved sessions. Optional arguments are `--prompt "Your description"` and repeatable `--reference "/absolute/path/to/image.png"`.

## MCP tool reference

| Tool | Purpose |
| --- | --- |
| `session_status` | Check readiness or cooldown for the server-selected session. |
| `generate_image` | Queue one image; accepts `prompt`, optional `reference_images`, and `aspect_ratio`. |
| `generate_images` | Queue 1–25 prompts; accepts shared references, ratio, and optional `same_chat_mandatory`. |
| `wait_for_job` | Wait 0–25 seconds; return only status and last update time, plus failure details if needed. |
| `get_job_status` | Read a job ID, status, and last update time, plus failure details if needed. |
| `get_batch_status` | Read batch ID/status and each job ID/status. |
| `get_image` | Retrieve a completed image's saved path and optional preview. |
| `list_jobs` | List recent jobs across all profiles; optional `limit` defaults to 20. |
| `cancel_job` | Cancel a queued job; running jobs cannot be cancelled through MCP. |
| `list_accounts` | List profile IDs, display names, saved-session availability, and active selection. |
| `add_account` | Create an empty profile; authenticate privately in the terminal/browser. |

The server selects accounts automatically. Only `add_account` takes an `account` input, to name the new profile. Job/batch lookups infer ownership from the ID. `wait_for_job` requires an individual `job_id`; `get_batch_status` requires `batch_id`. `get_image` accepts `image_index` (default 0) and `include_preview` (default true).

Tool responses use compact JSON. `generate_image` returns only `{id, status}`; `generate_images` returns `{id, status, jobs}` with IDs/statuses for its jobs. `wait_for_job` returns `{status, updatedAt}` and never includes image previews. Failed jobs additionally include an actionable error and, when relevant, `retryAfter`. Prompts, references, account routing, conversation URLs, attempt history, and image sizes are retained internally. Use `get_image` for the saved file path and optional preview. Account metadata is limited to account-management tools.

One shared local worker serves both clients. Each account has its own FIFO queue, with up to 25 waiting jobs. Accepted work continues after clients disconnect. Queued jobs survive restarts; interrupted running jobs become failed, and remaining jobs in their batches stop. No uncertain prompt is automatically resubmitted. An explicit conversation-length rejection permits one automatic rollover to a new chat with the original references. A confirmed image usage limit, or an assumed limit after two consecutive completed text-only responses without images, also permits eligible jobs to continue on another signed-in account with those references.

Live `session_status` checks and the terminal `status` command save the session and fully close their dedicated browser before returning, including when verification is required or the check fails. A busy status response leaves ongoing generation running.

All accounts share one browser slot. Before opening another account, the server waits for current browser work to finish, saves the session, and fully closes the previous dedicated browser. Fallback checks run one account at a time; rejected profiles close before checking the next. If closing fails, switching stops instead of opening another window. Controlled Chrome keeps one reused ChatGPT tab and removes surplus tabs from its dedicated profile. Consecutive batch jobs on the same account reuse that browser; when its queues finish, it closes automatically. Saved accounts, conversations, and images remain available; the next generation reopens the required profile. Image retrieval reads saved files without opening Chrome. A browser cleanup failure does not change a completed image into a failed job.

Fresh signed-in CDP browser starts use the same handoff as cookie setup: ordinary Chrome loads ChatGPT for 10 seconds, fully exits, and controlled Chrome opens the same account profile. Updated cookies and browser storage from the ordinary stage take precedence over saved snapshots. An already-open controlled browser is reused immediately, including for consecutive batch images. `CHATGPT_MANUAL_CLOSE_MS` changes the ordinary-stage delay; `0` waits for you to fully quit that dedicated Chrome. Complete any human verification in the visible browser if requested; the handoff preserves session state but cannot guarantee Cloudflare will never ask again. Both stages stay headless during tests.

## Configuration and local storage

See [.env.example](.env.example). The server loads `.env` from the project directory regardless of the client's working directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_DATA_DIR` | `.chatgpt-images` | Session, profile, jobs, references, and images. |
| `CHATGPT_BROWSER_MODE` | `cdp` | Installed Chrome; alternatives: `playwright` or `webkit`. |
| `CHATGPT_HEADLESS` | `false` | Visible browser; headless is available in alternative modes. |
| `CHATGPT_MANUAL_CLOSE_MS` | `10000` | Ordinary Chrome stage before setup checks and fresh signed-in CDP starts; `0` waits for manual exit. |
| `CHATGPT_AUTO_SWITCH_ACCOUNTS` | `true` | Switch eligible generation jobs to another ready signed-in profile on a confirmed image limit. |
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
  active-account.json       Last selected profile
  account-settings.json     Display names, priorities, and selection mode
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

These modes use separate profiles, import cookies directly, and close their browser when generation becomes idle or the command/server exits. WebKit is Playwright's build, not your installed Safari profile. The manual-first workflow and `browser:manual` command are Chrome-specific. No browser mode guarantees that a ChatGPT verification challenge will accept the session.

## Development

Install the test browser engines, then run the checks:

```sh
npm run browser:install
npm run browser:install:webkit
npm run check
npm test
```

All tests run headlessly, including installed-Chrome CDP and manual-handoff fixtures, managed Chromium, and WebKit. The test-only setup also applies to child clients and shared workers. `npm run test:live` uses headless Chrome too. This does not change normal startup, login, setup, or image-generation browser settings. You can run an individual test with `npx tsx --test test/chrome.test.ts`; test files load the same headless setup automatically.

Tests cover MCP connections, per-account isolation and locks, sequential visible cookie entry, manual Chrome handoff, uploads, background-tab submission, single/batch generation, bounded waits, image retrieval, restart recovery, persisted cooldowns, automatic account failover, and mandatory same-chat batch restarts. Browser fixtures use local pages and fake sessions; they do not consume ChatGPT image usage. The default CDP tests also need installed Google Chrome.

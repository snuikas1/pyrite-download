# Set up Pyrite on this Windows PC

You are Claude Code, started by the user in this unzipped Pyrite folder. When they ask you to set up or install Pyrite, do the whole setup yourself, in order, and check each result before the next step. Talk to them in short, plain sentences.

Pyrite is a browser extension for Microsoft Edge that checks memecoins on axiom.trade: the site's age, free red flags, and a deep check that uses Claude. This folder holds the extension (`extension\`), its helper (`bridge\`) and the helper's prompt (`utils\claude\`).

## Hard rules

- Install only. Never edit, delete or "fix" any file in this folder or in `%LOCALAPPDATA%\Pyrite\app`. If something in Pyrite itself looks broken, stop and tell the user what you saw; it gets fixed on their Mac.
- Never open, read or touch anything belonging to a browser profile, a crypto wallet, cookies, saved passwords or seed phrases. Pyrite needs none of it.
- Never ask for, type or store a private key, seed phrase or password. The only key Pyrite ever takes is an optional Helius API key, which the user pastes into the extension's popup himself.
- Never turn off Windows security, SmartScreen or antivirus to get past a block. Stop and tell the user instead.

## Steps

1. **Check the folder is whole.** These must exist: `bridge\install-windows.ps1`, `bridge\pyrite-bridge.mjs`, `extension\manifest.json`, `utils\claude\deep-system-prompt.md`. If any is missing, the zip was not fully extracted: tell the user to right-click the zip, choose Extract All, and start you again in the extracted folder.

2. **Run the installer.** Run it directly, not `Install Pyrite.cmd` (that one waits for a key press):
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File bridge\install-windows.ps1`
   It copies the app to `%LOCALAPPDATA%\Pyrite\app`, downloads Node.js and checks its SHA-256, checks the Claude login and model, registers the helper for Edge and Chrome, and runs the helper's self-test. It can take a few minutes. Read the whole output.
   - Every self-test line must start with `PASS`. A line starting `FAIL` stops the setup: show the user that line.
   - If it says to log in to Claude: tell the user to run `claude` in a new terminal, log in with their Claude subscription, close it, and then run the installer again.
   - If it says the plan can't run Opus 5.5 and Pyrite will use Sonnet 5.5, that is fine; tell the user.
   - The installer opens Edge's extensions page at the end (Chrome's only when Edge is not installed). You open it yourself in step 4 anyway.

3. **Confirm the Edge registration.** Read the registry value `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pyrite.bridge` (default). It must point at a `com.pyrite.bridge.json` under `%LOCALAPPDATA%\Pyrite`, and that file must exist. If either is missing, show the user what you found.

4. **Hand the user the one step only they can do.** Edge lets only a person load a folder extension. Copy the folder path `%LOCALAPPDATA%\Pyrite\app\extension` (expanded to the real path) to the clipboard with `Set-Clipboard`, open Edge on its extensions page with `Start-Process msedge edge://extensions`, then give the user exactly these steps:
   - Step 1: In Edge's extensions page, turn on **Developer mode** (left side, near the bottom).
   - Step 2: Click **Load unpacked**.
   - Step 3: Click the **Folder** box at the bottom of the window that opens, press **Ctrl+V**, press **Enter**.
   - Step 4: Click **Select Folder**.
   - Step 5: Tell me when the Pyrite card shows up.
   If Pyrite was loaded before from another folder, tell them to click Remove on the old card first.

5. **Verify.** After the user says it loaded: the card must show the name Pyrite and a version starting `0.2`. Ask them to click the Pyrite icon in Edge's toolbar (puzzle-piece menu if it is not pinned) and check that the Claude switch reaches **ready**. If it does not, run the self-test again and show the user its output:
   `"%LOCALAPPDATA%\Pyrite\app\node\node.exe" "%LOCALAPPDATA%\Pyrite\app\bridge\pyrite-bridge.mjs" --selftest`
   (If `node\node.exe` is not there, look for the node path the installer printed on its `node` line.)

6. **Finish.** Tell the user it is set up and how to use it: open axiom.trade and click a coin; the pill shows the site's age and any red flags; the silver magnifier runs a deep check, which uses their Claude plan. If Edge ever offers to turn off developer-mode extensions, they click Cancel. Optional: a free Helius key from dashboard.helius.dev, pasted into Pyrite's popup, adds on-chain detail.

If anything does not match these steps, stop, show the user exactly what you saw, and do not improvise a workaround.

// Browser + macOS system control, ported from Hannibal V1 (main-v2.js).
// AppleScript via osascript, plus shell helpers. Registers two IPC handlers:
//   'browser-action' (Chrome) and 'mac-control' (apps, volume, Spotify, files…).
const { exec } = require('child_process');
const fs = require('fs');

function registerControls(ipcMain) {
  // ── BROWSER CONTROL (Google Chrome via AppleScript) ──
  ipcMain.handle('browser-action', (event, action, params) => {
    console.log('Browser action:', action, params);

    const chromeScript = (body) => `
      tell application "Google Chrome"
        activate
        ${body}
      end tell`;

    const openUrl = (url) => {
      if (!url.startsWith('http')) url = 'https://' + url;
      return chromeScript(`
        if (count of windows) = 0 then
          make new window
        end if
        set URL of active tab of front window to "${url.replace(/"/g, '\\"')}"`);
    };

    let script = '';

    switch (action) {
      case 'open':
        script = openUrl(params.trim());
        break;

      case 'search':
        script = openUrl(`https://www.google.com/search?q=${encodeURIComponent(params.trim())}`);
        break;

      case 'youtube':
        script = openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(params.trim())}`);
        break;

      case 'tab':
        if (params.trim().toLowerCase() === 'new') {
          script = chromeScript(`
            if (count of windows) = 0 then
              make new window
            else
              tell front window to make new tab
            end if`);
        }
        break;

      case 'close-tab':
        script = chromeScript(`
          if (count of windows) > 0 then
            close active tab of front window
          end if`);
        break;

      case 'close-browser':
        script = `tell application "Google Chrome" to quit`;
        break;

      case 'next-tab':
        script = chromeScript(`
          if (count of windows) > 0 then
            tell front window
              set tabCount to count of tabs
              set idx to active tab index
              if idx < tabCount then
                set active tab index to idx + 1
              else
                set active tab index to 1
              end if
            end tell
          end if`);
        break;

      case 'prev-tab':
        script = chromeScript(`
          if (count of windows) > 0 then
            tell front window
              set tabCount to count of tabs
              set idx to active tab index
              if idx > 1 then
                set active tab index to idx - 1
              else
                set active tab index to tabCount
              end if
            end tell
          end if`);
        break;

      case 'back':
        script = `tell application "System Events" to tell process "Google Chrome" to keystroke "[" using command down`;
        break;

      case 'forward':
        script = `tell application "System Events" to tell process "Google Chrome" to keystroke "]" using command down`;
        break;

      case 'refresh':
        script = `tell application "System Events" to tell process "Google Chrome" to keystroke "r" using command down`;
        break;

      case 'read-page':
        script = chromeScript(`
          if (count of windows) > 0 then
            set t to title of active tab of front window
            set u to URL of active tab of front window
            return t & "|" & u
          else
            return "No windows open"
          end if`);
        return new Promise((resolve) => {
          exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
            if (err) { resolve({ success: false, data: '' }); return; }
            const parts = stdout.trim().split('|');
            resolve({ success: true, title: parts[0] || '', url: parts[1] || '' });
          });
        });

      case 'list-tabs':
        script = chromeScript(`
          if (count of windows) > 0 then
            set tabList to ""
            tell front window
              repeat with t in tabs
                set tabList to tabList & title of t & "||"
              end repeat
            end tell
            return tabList
          else
            return ""
          end if`);
        return new Promise((resolve) => {
          exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
            if (err) { resolve({ success: false, tabs: [] }); return; }
            const tabs = stdout.trim().split('||').filter((t) => t.length > 0);
            resolve({ success: true, tabs });
          });
        });

      case 'goto-tab': {
        const tabNum = parseInt(params);
        if (tabNum > 0) {
          script = chromeScript(`
            if (count of windows) > 0 then
              tell front window
                if ${tabNum} ≤ (count of tabs) then
                  set active tab index to ${tabNum}
                end if
              end tell
            end if`);
        }
        break;
      }

      case 'bookmark': {
        const bookmarks = {
          'supabase': 'https://supabase.com/dashboard',
          'vercel': 'https://vercel.com/dashboard',
          'github': 'https://github.com',
          'drive': 'https://drive.google.com',
          'docs': 'https://docs.google.com',
          'sheets': 'https://sheets.google.com',
          'calendar': 'https://calendar.google.com',
          'claude': 'https://claude.ai',
          'chatgpt': 'https://chat.openai.com',
          'n8n': 'http://localhost:5678',
          'lovable': 'https://lovable.dev',
          'notion': 'https://notion.so',
          'slack': 'https://app.slack.com',
          'twitter': 'https://x.com',
          'linkedin': 'https://linkedin.com',
          'suite synq': 'https://suitesynq.com',
          'mellow yellow': 'https://mellowyellow.exchange',
          'revalis': 'https://revalisgroup.com',
          'stripe': 'https://dashboard.stripe.com',
        };
        const key = params.trim().toLowerCase();
        const bmUrl = bookmarks[key];
        if (bmUrl) {
          script = openUrl(bmUrl);
        } else {
          console.log('Unknown bookmark:', key);
          return false;
        }
        break;
      }

      case 'scroll-down':
        script = `
          tell application "Google Chrome" to activate
          delay 0.2
          tell application "System Events" to tell process "Google Chrome"
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
            key code 125
          end tell`;
        break;

      case 'scroll-up':
        script = `
          tell application "Google Chrome" to activate
          delay 0.2
          tell application "System Events" to tell process "Google Chrome"
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
            key code 126
          end tell`;
        break;

      case 'scroll-bottom':
        script = `
          tell application "Google Chrome" to activate
          delay 0.2
          tell application "System Events" to tell process "Google Chrome"
            key code 119 using {fn down}
          end tell`;
        break;

      case 'scroll-top':
        script = `
          tell application "Google Chrome" to activate
          delay 0.2
          tell application "System Events" to tell process "Google Chrome"
            key code 115 using {fn down}
          end tell`;
        break;

      case 'read-content': {
        const readScript = `
          tell application "Google Chrome"
            if (count of windows) > 0 then
              set pageText to execute active tab of front window javascript "
                (function() {
                  var el = document.querySelector('article') || document.querySelector('main') || document.querySelector('.content') || document.body;
                  return el.innerText.substring(0, 3000);
                })()
              "
              return pageText
            else
              return "No windows open"
            end if
          end tell`;
        return new Promise((resolve) => {
          exec(`osascript -e '${readScript.replace(/'/g, "'\\''")}'`, (err, stdout) => {
            if (err) { resolve({ success: false, data: 'Could not read page' }); return; }
            resolve({ success: true, data: stdout.trim().substring(0, 2000) });
          });
        });
      }

      case 'type-in-browser': {
        const text = typeof params === 'string' ? params : params.text || '';
        return new Promise((resolve) => {
          exec(`osascript -e '
            tell application "Google Chrome" to activate
            delay 0.3
            tell application "System Events"
              tell process "Google Chrome"
                keystroke "${text.replace(/"/g, '\\"')}"
              end tell
            end tell'`, (err) => {
            resolve({ success: !err, data: err ? err.message : 'Typed.' });
          });
        });
      }

      case 'click-link': {
        const linkText = typeof params === 'string' ? params : params.text || '';
        const clickScript = `
          tell application "Google Chrome"
            execute active tab of front window javascript "
              (function() {
                var links = document.querySelectorAll('a, button');
                for (var i = 0; i < links.length; i++) {
                  if (links[i].innerText.toLowerCase().includes('${linkText.toLowerCase().replace(/'/g, "\\'")}')) {
                    links[i].click();
                    return 'Clicked: ' + links[i].innerText.substring(0, 50);
                  }
                }
                return 'Link not found';
              })()
            "
          end tell`;
        return new Promise((resolve) => {
          exec(`osascript -e '${clickScript.replace(/'/g, "'\\''")}'`, (err, stdout) => {
            resolve({ success: !err, data: stdout ? stdout.trim() : 'Click attempted' });
          });
        });
      }

      case 'fill-field': {
        const p = typeof params === 'string' ? JSON.parse(params) : params;
        const fieldScript = `
          tell application "Google Chrome"
            execute active tab of front window javascript "
              (function() {
                var fields = document.querySelectorAll('input, textarea');
                for (var i = 0; i < fields.length; i++) {
                  var f = fields[i];
                  var label = f.placeholder || f.name || f.id || '';
                  if (label.toLowerCase().includes('${(p.field || '').toLowerCase().replace(/'/g, "\\'")}')) {
                    f.focus();
                    f.value = '${(p.value || '').replace(/'/g, "\\'")}';
                    f.dispatchEvent(new Event('input', {bubbles: true}));
                    return 'Filled: ' + label;
                  }
                }
                return 'Field not found';
              })()
            "
          end tell`;
        return new Promise((resolve) => {
          exec(`osascript -e '${fieldScript.replace(/'/g, "'\\''")}'`, (err, stdout) => {
            resolve({ success: !err, data: stdout ? stdout.trim() : 'Fill attempted' });
          });
        });
      }

      default:
        console.log('Unknown browser action:', action);
        return false;
    }

    if (script) {
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
        if (err) console.error('Browser action error:', err.message);
        else console.log('Browser action complete');
      });
    }
    return true;
  });

  // ── WHATSAPP (via Contacts + whatsapp:// link, checked after sending) ──
  const wa = require('./whatsapp');
  ipcMain.handle('contacts:find', (_e, query) => wa.findContacts(query));
  ipcMain.handle('whatsapp:send', (_e, contact, message, number) => wa.sendWhatsApp({ contact, message, number }));

  // ── MAC SYSTEM CONTROL ──
  ipcMain.handle('mac-control', (event, action, params) => {
    console.log('Mac control:', action, params);

    const run = (script) => new Promise((resolve) => {
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
        if (err) { console.error('Mac control error:', err.message); resolve({ success: false, error: err.message }); }
        else resolve({ success: true, data: stdout.trim() });
      });
    });

    const shell = (cmd) => new Promise((resolve) => {
      exec(cmd, (err, stdout) => {
        if (err) { console.error('Shell error:', err.message); resolve({ success: false, error: err.message }); }
        else resolve({ success: true, data: stdout.trim() });
      });
    });

    switch (action) {
      // === APP CONTROL ===
      case 'open-app': {
        // Resolve a spoken/typed name to an installed .app, in this order:
        //   1) alias map (common spoken nicknames → exact macOS app name)
        //   2) Title-Cased guess via `open -a` (LaunchServices already handles
        //      a lot of fuzziness — case, .app suffix, partial matches)
        //   3) case-insensitive `contains` match across /Applications and
        //      ~/Applications, picking the first hit
        // Returns {success:true, data:'Opening X.'} or {success:false,
        // error:"I couldn't find an app called X."} so the voice layer can
        // speak the error verbatim (set cmd.speakError in voice-controller).
        const aliases = {
          'chrome': 'Google Chrome', 'google chrome': 'Google Chrome',
          'safari': 'Safari', 'firefox': 'Firefox', 'arc': 'Arc', 'brave': 'Brave Browser',
          'terminal': 'Terminal', 'iterm': 'iTerm', 'iterm2': 'iTerm',
          'finder': 'Finder',
          'mail': 'Mail', 'messages': 'Messages', 'whatsapp': 'WhatsApp',
          'notes': 'Notes', 'calendar': 'Calendar', 'reminders': 'Reminders',
          'maps': 'Maps', 'preview': 'Preview', 'photos': 'Photos',
          'music': 'Music', 'spotify': 'Spotify', 'vlc': 'VLC', 'iina': 'IINA',
          'slack': 'Slack', 'discord': 'Discord', 'zoom': 'zoom.us',
          'teams': 'Microsoft Teams', 'microsoft teams': 'Microsoft Teams',
          'figma': 'Figma', 'sketch': 'Sketch', 'canva': 'Canva',
          'notion': 'Notion', 'linear': 'Linear', 'obsidian': 'Obsidian', 'bear': 'Bear',
          'raycast': 'Raycast', 'alfred': 'Alfred', 'cleanshot': 'CleanShot X',
          'vs code': 'Visual Studio Code', 'vscode': 'Visual Studio Code', 'code': 'Visual Studio Code',
          'cursor': 'Cursor', 'xcode': 'Xcode',
          'sublime': 'Sublime Text', 'sublime text': 'Sublime Text',
          'intellij': 'IntelliJ IDEA', 'pycharm': 'PyCharm', 'webstorm': 'WebStorm',
          'pages': 'Pages', 'numbers': 'Numbers', 'keynote': 'Keynote',
          'word': 'Microsoft Word', 'excel': 'Microsoft Excel', 'powerpoint': 'Microsoft PowerPoint',
          'system settings': 'System Settings', 'system preferences': 'System Settings',
          'activity monitor': 'Activity Monitor',
          'chatgpt': 'ChatGPT', 'claude': 'Claude',
        };
        const raw = (params || '').trim();
        if (!raw) return Promise.resolve({ success: false, error: "What app should I open?" });
        const lower = raw.toLowerCase();
        // Strip common qualifiers so "chrome browser" / "spotify app" / "the
        // chrome browser" / "vs code editor" find their alias entries. Leading
        // articles peel off first, then trailing/inline qualifiers. Order
        // matters: multi-word patterns before their single-word substrings.
        // If stripping leaves nothing useful, fall back to the original.
        const stripped = lower
          .replace(/^(the|a|an)\s+/, '')
          .replace(/\b(web browser|browser|application|app|editor|client|program|software|tool)\b/g, '')
          .replace(/\s+/g, ' ').trim();
        const lookupKey = stripped || lower;
        const titleCaseSource = stripped || lower;
        const resolved = aliases[lookupKey]
          || aliases[lower]
          || titleCaseSource.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        // Stage 1: exact `open -a` (LaunchServices). Stage 2: fuzzy scan of
        // /Applications and ~/Applications, opening the first .app whose name
        // contains the query (case-insensitive).
        const script = `
          if open -a ${shq(resolved)} 2>/dev/null; then
            printf 'Opening %s.' ${shq(resolved)}
            exit 0
          fi
          for dir in /Applications "$HOME/Applications"; do
            [ -d "$dir" ] || continue
            HIT=$(/bin/ls "$dir" 2>/dev/null | /usr/bin/grep -iE '\\.app$' | /usr/bin/grep -iF ${shq(lower)} | head -1)
            if [ -n "$HIT" ]; then
              open -a "$dir/$HIT" && printf 'Opening %s.' "\${HIT%.app}"
              exit 0
            fi
          done
          exit 1
        `;
        return new Promise((resolve) => {
          exec(script, (err, stdout) => {
            if (err) resolve({ success: false, error: "I couldn't find an app called " + raw + "." });
            else resolve({ success: true, data: stdout.trim() || ('Opening ' + resolved + '.') });
          });
        });
      }
      case 'open-in-editor': {
        // Open a project folder in a dev tool by NAME. Param is JSON:
        //   {"editor":"claude"|"cc"|"cursor"|"code"|"vscode", "project":"name-or-path"}
        // Project resolution walks common roots (~/Desktop/Projects, ~/projects,
        // etc) and picks the first directory whose name contains the query.
        // If project starts with / or ~ it's treated as an explicit path.
        // - claude/cc → opens Terminal and runs `cd <path> && claude`
        // - cursor    → `open -a "Cursor" <path>`
        // - code/vscode → `open -a "Visual Studio Code" <path>`
        // Returns {success:false, error:"I can't find a project called X. What's the path?"}
        // on miss so voice can prompt the user.
        const p = typeof params === 'string' ? (() => { try { return JSON.parse(params); } catch { return {}; } })() : (params || {});
        const editorRaw = String(p.editor || '').toLowerCase().replace(/\s+/g, '');
        const projectRaw = String(p.project || '').trim();
        if (!editorRaw || !projectRaw) {
          return Promise.resolve({ success: false, error: 'Which editor and which project?' });
        }
        const editorApp = (editorRaw === 'cursor') ? 'Cursor'
          : (editorRaw === 'code' || editorRaw === 'vscode' || editorRaw === 'vsc') ? 'Visual Studio Code'
          : (editorRaw === 'claude' || editorRaw === 'cc' || editorRaw === 'claudecode') ? 'claude'
          : null;
        if (!editorApp) return Promise.resolve({ success: false, error: 'I don\'t know that editor.' });
        const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        const expanded = projectRaw.startsWith('~/') ? (process.env.HOME + projectRaw.slice(1)) : projectRaw;
        const explicitPath = expanded.startsWith('/');
        const findScript = explicitPath
          ? `[ -d ${shq(expanded)} ] && printf '%s' ${shq(expanded)}`
          : `
            QUERY=${shq(projectRaw)}
            for root in "$HOME/Desktop/Projects" "$HOME/projects" "$HOME/Projects" "$HOME/code" "$HOME/work" "$HOME/dev"; do
              [ -d "$root" ] || continue
              HIT=$(/usr/bin/find "$root" -maxdepth 1 -mindepth 1 -type d -iname "*$QUERY*" 2>/dev/null | head -1)
              if [ -n "$HIT" ]; then printf '%s' "$HIT"; exit 0; fi
            done
            for root in "$HOME" "$HOME/Desktop"; do
              HIT=$(/usr/bin/find "$root" -maxdepth 1 -mindepth 1 -type d -iname "*$QUERY*" 2>/dev/null | grep -v "/Library$\\|/Applications$\\|/Pictures$\\|/Music$\\|/Movies$\\|/Public$" | head -1)
              if [ -n "$HIT" ]; then printf '%s' "$HIT"; exit 0; fi
            done
            exit 1
          `;
        return new Promise((resolve) => {
          exec(findScript, (err, stdout) => {
            const path = (stdout || '').trim();
            if (err || !path) {
              resolve({ success: false, error: "I can't find a project called " + projectRaw + ". What's the path?" });
              return;
            }
            const base = path.split('/').pop() || projectRaw;
            if (editorApp === 'claude') {
              // Reuse the existing front Terminal window/tab when there is one
              // — `do script "…"` with no `in` clause opens a NEW window every
              // time, which the user explicitly wants to stop. With `in window
              // 1` it runs in the frontmost tab of the front window instead.
              const apple = `tell application "Terminal"
  activate
  if (count of windows) > 0 then
    do script "cd " & quoted form of "${path.replace(/"/g, '\\"')}" & " && claude" in window 1
  else
    do script "cd " & quoted form of "${path.replace(/"/g, '\\"')}" & " && claude"
  end if
end tell`;
              exec(`osascript -e ${shq(apple)}`, (err2) => {
                if (err2) resolve({ success: false, error: 'Could not start Claude Code in ' + base + '.' });
                else resolve({ success: true, data: 'Opening ' + base + ' in Claude Code.' });
              });
            } else {
              exec(`open -a ${shq(editorApp)} ${shq(path)}`, (err2) => {
                if (err2) resolve({ success: false, error: 'Could not open ' + editorApp + ' with ' + base + '.' });
                else resolve({ success: true, data: 'Opening ' + base + ' in ' + editorApp + '.' });
              });
            }
          });
        });
      }
      case 'quit-app':    return shell(`osascript -e 'tell application "${params}" to quit' 2>/dev/null || pkill -x "${params}" 2>/dev/null && echo "Closed ${params}"`);
      case 'list-apps':   return shell(`osascript -e 'tell application "System Events" to get name of every process whose background only is false'`);
      case 'switch-app':  return shell(`open -a "${params}"`);
      case 'hide-app':    return run(`tell application "System Events" to set visible of process "${params}" to false`);
      case 'minimize':    return run(`tell application "System Events" to tell process "${params}" to set miniaturized of every window to true`);

      // === VOLUME ===
      case 'volume-up':     return run(`set volume output volume ((output volume of (get volume settings)) + 10)`);
      case 'volume-down':   return run(`set volume output volume ((output volume of (get volume settings)) - 10)`);
      case 'volume-set':    return run(`set volume output volume ${parseInt(params) || 50}`);
      case 'volume-mute':   return run(`set volume output muted true`);
      case 'volume-unmute': return run(`set volume output muted false`);
      case 'volume-get':    return run(`set v to (get volume settings)
        set vol to output volume of v
        set muted to output muted of v
        return "Volume: " & vol & "%, Muted: " & muted`);

      // === DISPLAY ===
      case 'brightness-up':     return shell(`brightness $(echo "$(brightness -l 2>/dev/null | grep brightness | awk '{print $NF}') + 0.1" | bc) 2>/dev/null || osascript -e 'tell application "System Events" to key code 144'`);
      case 'brightness-down':   return shell(`osascript -e 'tell application "System Events" to key code 145'`);
      case 'dark-mode':         return run(`tell application "System Events" to tell appearance preferences to set dark mode to ${params === 'on' ? 'true' : 'false'}`);
      case 'dark-mode-toggle':  return run(`tell application "System Events" to tell appearance preferences to set dark mode to not dark mode`);

      // === FINDER & FILES ===
      case 'open-folder':     return run(`tell application "Finder" to open POSIX file "${params}"`);
      case 'open-file':       return shell(`open "${params}"`);
      case 'find-file':       return shell(`mdfind -name "${params}" 2>/dev/null | head -10`);
      case 'trash':           return shell(`osascript -e 'tell application "Finder" to delete POSIX file "${params}"'`);
      case 'desktop-files':   return shell(`ls -1 ~/Desktop/ | head -20`);
      case 'downloads-files': return shell(`ls -1t ~/Downloads/ | head -20`);
      case 'recent-files':    return shell(`mdfind -onlyin ~ 'kMDItemFSContentChangeDate >= $time.today(-1)' 2>/dev/null | head -15`);

      // === RICH FILE SEARCH / READ (Spotlight-backed, returns structured JSON) ===
      case 'file-search': {
        // Params: {query, type?:'pdf'|'doc'|'all', location?:'all'|'downloads'|'desktop'|'documents'|'projects'}
        // Uses mdfind so even huge home trees return ~instantly. Returns up to
        // 10 hits, each with {path, name, size, mtime}. The voice layer reads
        // the top few names aloud and stashes the full list so a follow-up
        // like "open that" can pick the first result.
        const p = typeof params === 'string'
          ? (() => { try { return JSON.parse(params); } catch { return { query: params }; } })()
          : (params || {});
        const query = String(p.query || '').trim();
        if (!query) return Promise.resolve({ success: false, error: 'What should I search for?' });
        const type = String(p.type || 'all').toLowerCase();
        const loc = String(p.location || 'all').toLowerCase();
        const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        const locFlag =
          loc === 'downloads' ? `-onlyin "$HOME/Downloads" ` :
          loc === 'desktop'   ? `-onlyin "$HOME/Desktop" ` :
          loc === 'documents' ? `-onlyin "$HOME/Documents" ` :
          loc === 'projects'  ? `-onlyin "$HOME/Desktop/Projects" -onlyin "$HOME/projects" ` :
          '';
        // Filter by extension if requested. 'doc' covers .doc + .docx + .pages.
        const extFilter =
          type === 'pdf' ? `| /usr/bin/grep -i '\\.pdf$'` :
          type === 'doc' ? `| /usr/bin/grep -iE '\\.(docx?|pages|rtf|odt)$'` :
          '';
        const cmd = `mdfind ${locFlag}-name ${shq(query)} 2>/dev/null ${extFilter} | head -10`;
        return new Promise((resolve) => {
          exec(cmd, (err, stdout) => {
            if (err && !stdout) { resolve({ success: false, error: 'Search failed.' }); return; }
            const paths = stdout.trim().split('\n').filter(Boolean);
            const results = paths.map((fp) => {
              try {
                const st = fs.statSync(fp);
                return { path: fp, name: fp.split('/').pop(), size: st.size, mtime: st.mtime.toISOString() };
              } catch (_) { return null; }
            }).filter(Boolean);
            resolve({ success: true, data: JSON.stringify(results) });
          });
        });
      }

      case 'file-list': {
        // Params: {folder, sort?:'recent'|'name'|'size'}. Returns a formatted
        // listing (the same shape ls produces — no JSON parsing needed on the
        // voice side). For `recent`, sorts by mtime newest first.
        const p = typeof params === 'string'
          ? (() => { try { return JSON.parse(params); } catch { return { folder: params }; } })()
          : (params || {});
        const folder = String(p.folder || '~').replace(/^~/, process.env.HOME || '~');
        const sort = String(p.sort || 'recent').toLowerCase();
        const sortFlag = sort === 'name' ? '' : sort === 'size' ? 'S' : 't';
        const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        return new Promise((resolve) => {
          exec(`/bin/ls -lha${sortFlag} ${shq(folder)} 2>/dev/null | head -30`, (err, stdout) => {
            if (err) { resolve({ success: false, error: 'Could not list that folder.' }); return; }
            resolve({ success: true, data: stdout.trim() });
          });
        });
      }

      case 'file-open': {
        // Trivial — defers to LaunchServices via `open`. Accepts either a bare
        // path string or {path}. Path arg is shell-quoted to handle spaces.
        const path = typeof params === 'string' ? params : (params && params.path) || '';
        if (!path) return Promise.resolve({ success: false, error: 'No path.' });
        const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
        return new Promise((resolve) => {
          exec(`open ${shq(path)}`, (err) => {
            if (err) resolve({ success: false, error: 'Could not open ' + path.split('/').pop() + '.' });
            else resolve({ success: true, data: 'Opening ' + path.split('/').pop() + '.' });
          });
        });
      }

      case 'file-recent': {
        // Params: {hours?:24, type?:'all'|'pdf'|'doc'|'code'}. Spotlight's date
        // predicate is much faster than `find -mmin` on a populated home tree.
        const p = typeof params === 'string'
          ? (() => { try { return JSON.parse(params); } catch { return {}; } })()
          : (params || {});
        const hours = Math.max(1, parseInt(p.hours || 24, 10));
        const type = String(p.type || 'all').toLowerCase();
        const seconds = hours * 3600;
        const extFilter =
          type === 'pdf'  ? `| /usr/bin/grep -i '\\.pdf$'` :
          type === 'doc'  ? `| /usr/bin/grep -iE '\\.(docx?|pages|rtf|odt|txt|md)$'` :
          type === 'code' ? `| /usr/bin/grep -iE '\\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|swift|sh|json|yml|yaml)$'` :
          '';
        // Skip dotfiles and Library noise so the user sees real work.
        const cmd = `mdfind -onlyin "$HOME" "kMDItemFSContentChangeDate >= \\$time.now(-${seconds})" 2>/dev/null | /usr/bin/grep -v '/Library/' | /usr/bin/grep -v '/\\.' ${extFilter} | head -20`;
        return new Promise((resolve) => {
          exec(cmd, (err, stdout) => {
            if (err && !stdout) { resolve({ success: false, error: 'Recent-files lookup failed.' }); return; }
            const paths = stdout.trim().split('\n').filter(Boolean);
            const results = paths.map((fp) => {
              try {
                const st = fs.statSync(fp);
                return { path: fp, name: fp.split('/').pop(), size: st.size, mtime: st.mtime.toISOString() };
              } catch (_) { return null; }
            }).filter(Boolean);
            resolve({ success: true, data: JSON.stringify(results) });
          });
        });
      }

      case 'file-read': {
        // Returns raw UTF-8 text for the voice layer to speak or summarize.
        // Hard cap at 200 KB so a stray pointer to a binary doesn't OOM the
        // renderer. Caller decides whether to feed long content through the
        // LLM for a spoken summary.
        const path = typeof params === 'string' ? params : (params && params.path) || '';
        if (!path) return Promise.resolve({ success: false, error: 'No path.' });
        return new Promise((resolve) => {
          fs.stat(path, (err, st) => {
            if (err) { resolve({ success: false, error: 'File not found.' }); return; }
            if (!st.isFile()) { resolve({ success: false, error: 'Not a file.' }); return; }
            if (st.size > 200 * 1024) { resolve({ success: false, error: 'File too large to read aloud.' }); return; }
            fs.readFile(path, 'utf8', (err2, data) => {
              if (err2) { resolve({ success: false, error: 'Could not read file (probably binary).' }); return; }
              resolve({ success: true, data, size: st.size, path, name: path.split('/').pop() });
            });
          });
        });
      }

      // === SCREENSHOTS ===
      case 'screenshot':           return shell(`screencapture -x ~/Desktop/screenshot-$(date +%Y%m%d-%H%M%S).png && echo "Screenshot saved to Desktop"`);
      case 'screenshot-clipboard': return shell(`screencapture -c -x && echo "Screenshot copied to clipboard"`);
      case 'screenshot-window':    return shell(`screencapture -w -x ~/Desktop/screenshot-$(date +%Y%m%d-%H%M%S).png && echo "Window screenshot saved"`);

      // === SYSTEM ===
      case 'battery':       return shell(`pmset -g batt | grep -Eo '\\d+%' | head -1`);
      case 'wifi-status':   return shell(`networksetup -getairportnetwork en0 2>/dev/null || echo "Wi-Fi info unavailable"`);
      case 'wifi-toggle':   return shell(`networksetup -setairportpower en0 ${params === 'on' ? 'on' : 'off'}`);
      case 'bluetooth-toggle': return shell(`blueutil --power ${params === 'on' ? '1' : '0'} 2>/dev/null || echo "blueutil not installed"`);
      case 'sleep':         return run(`tell application "System Events" to sleep`);
      case 'lock':          return shell(`pmset displaysleepnow`);
      case 'empty-trash':   return run(`tell application "Finder" to empty trash`);
      case 'disk-space':    return shell(`df -h / | tail -1 | awk '{print "Used: "$3" / "$2" ("$5" full)"}'`);
      case 'uptime':        return shell(`uptime | sed 's/.*up /Up /' | sed 's/,.*//'`);
      case 'top-cpu':       return shell(`ps aux --sort=-%cpu | head -6 | awk '{printf "%-4s %-20s %s\\n", $3"%", $11, $1}'`);
      case 'memory-usage':  return shell(`memory_pressure | tail -1`);
      case 'ip-address':    return shell(`ipconfig getifaddr en0 2>/dev/null || echo "Not connected"`);

      // === MUSIC / MEDIA ===
      case 'play-pause':      return run(`tell application "System Events" to key code 49 using {}`);
      case 'next-track':      return run(`tell application "System Events" to key code 124 using {command down}`);
      case 'prev-track':      return run(`tell application "System Events" to key code 123 using {command down}`);
      case 'spotify-play':    return run(`tell application "Spotify" to play`);
      case 'spotify-pause':   return run(`tell application "Spotify" to pause`);
      case 'spotify-next':    return run(`tell application "Spotify" to next track`);
      case 'spotify-prev':    return run(`tell application "Spotify" to previous track`);
      case 'spotify-current': return run(`tell application "Spotify"
        set t to name of current track
        set a to artist of current track
        return t & " by " & a
      end tell`);

      // === NOTIFICATIONS ===
      case 'notify': return run(`display notification "${params}" with title "Hannibal"`);
      case 'say':    return shell(`say "${params}"`);

      // === SHELL COMMAND (careful!) ===
      case 'shell':  return shell(params);

      // === MESSAGING ===
      case 'whatsapp-send': {
        // WhatsApp Mac is a Catalyst app with stripped-down accessibility:
        // chat rows have NO name/title — only a `value` like
        // "bericht, Hi, 16:34, Ontvangen van Mandy" (locale-dependent). Also
        // `entire contents of window 1` returns 0 elements here, so we must
        // recurse the UI tree by hand. CRITICALLY: `tell application
        // "WhatsApp" to activate` does NOT make WhatsApp frontmost on its
        // own; without `set frontmost to true`, Cmd+F and the typed name
        // leak to whatever app is currently in front. That was the silent
        // failure of the previous implementation ("opens app but doesn't
        // type the contact name").
        //
        // Flow: activate → frontmost → Cmd+F → type name → walk tree for
        // first AXButton whose `value contains` the contact name → click →
        // walk again for the AXTextArea (composer) → click → type → Return.
        // LOCALE-INDEPENDENT contact match (case-insensitive across a row's
        // value/name/description; first-name fallback; else open the TOP result).
        // COMPOSER: do NOT hunt for the text field — in an empty/fresh chat the
        // composer often isn't AX-exposed (that was the NO_COMPOSER failure).
        // Instead rely on WhatsApp giving the composer default keyboard focus
        // once a chat is open: just type. VERIFY honestly by confirming the sent
        // message appears as a BUBBLE (a non-text-field element), which IS
        // AX-exposed after sending — only then report success.
        const p = typeof params === 'string' ? JSON.parse(params) : params;
        const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
        const name = esc(p.contact || p.name);
        const firstName = esc((p.contact || p.name || '').split(/\s+/)[0]);
        const msg = esc(p.message);
        const msgProbe = esc(String(p.message || '').slice(0, 24)); // distinctive substring to find the bubble
        if (!name) return { success: false, error: 'No contact name provided' };
        if (!msg) return { success: false, error: 'No message provided' };
        const waScript = `global gFoundBubble, gFoundField

on matchesTarget(el, target)
  if target is "" then return false
  tell application "System Events"
    set hay to ""
    try
      set hay to hay & " " & ((value of el) as string)
    end try
    try
      set hay to hay & " " & ((name of el) as string)
    end try
    try
      set hay to hay & " " & ((description of el) as string)
    end try
  end tell
  ignoring case
    if hay contains target then return true
  end ignoring
  return false
end matchesTarget

on findRow(parent, target, depth, maxDepth)
  if depth > maxDepth then return missing value
  tell application "System Events"
    try
      repeat with k in (UI elements of parent)
        try
          set r to (value of attribute "AXRole" of k) as string
          if r is "AXButton" or r is "AXCell" or r is "AXRow" then
            if my matchesTarget(k, target) then return contents of k
          end if
          set deeper to my findRow(k, target, depth + 1, maxDepth)
          if deeper is not missing value then return deeper
        end try
      end repeat
    end try
  end tell
  return missing value
end findRow

-- Scan the whole window for the message text. If it appears in a non-textarea
-- element it's a SENT BUBBLE (success); if only in an AXTextArea it's still
-- sitting in the composer (not sent).
on scanForText(parent, target, depth, maxDepth)
  global gFoundBubble, gFoundField
  if depth > maxDepth then return
  tell application "System Events"
    try
      repeat with k in (UI elements of parent)
        try
          set hay to ""
          try
            set hay to hay & " " & ((value of k) as string)
          end try
          try
            set hay to hay & " " & ((description of k) as string)
          end try
          set isHit to false
          ignoring case
            if hay contains target then set isHit to true
          end ignoring
          if isHit then
            set rr to ""
            try
              set rr to (value of attribute "AXRole" of k) as string
            end try
            if rr is "AXTextArea" then
              set gFoundField to true
            else
              set gFoundBubble to true
            end if
          end if
          my scanForText(k, target, depth + 1, maxDepth)
        end try
      end repeat
    end try
  end tell
end scanForText

tell application "WhatsApp" to activate
delay 0.6
tell application "System Events"
  tell process "WhatsApp"
    set frontmost to true
    delay 0.4
    keystroke "f" using command down
    delay 0.6
    keystroke "a" using command down
    key code 51
    delay 0.2
    keystroke "${name}"
    delay 1.6
    set rowEl to my findRow(window 1, "${name}", 0, 18)
    if rowEl is missing value then
      set rowEl to my findRow(window 1, "${firstName}", 0, 18)
    end if
    set rowMatched to "no"
    if rowEl is missing value then
      key code 36
      delay 1.8
    else
      set rowMatched to "yes"
      click rowEl
      delay 1.8
    end if
    -- diagnostic: what holds keyboard focus now (composer should be AXTextArea)?
    set focusRole to "none"
    try
      set focusRole to (value of attribute "AXRole" of (value of attribute "AXFocusedUIElement")) as string
    end try
    -- type directly into the chat's default-focused composer, then send
    keystroke "${msg}"
    delay 0.5
    key code 36
    delay 1.3
    -- verify: did the message land as a sent bubble?
    set gFoundBubble to false
    set gFoundField to false
    my scanForText(window 1, "${msgProbe}", 0, 22)
    set verdict to "NO_TYPE"
    if gFoundBubble then
      set verdict to "SENT"
    else if gFoundField then
      set verdict to "NOT_SENT"
    end if
    return "rowMatched=" & rowMatched & " focus=" & focusRole & " verify=" & verdict
  end tell
end tell`;
        return run(waScript).then((result) => {
          if (!result.success) return result;                  // osascript-level failure
          const data = String(result.data || '').trim();
          // One diagnostic line per run: chat opened? what got focus? verdict?
          console.log('[whatsapp-send] diag:', data);
          const m = data.match(/verify=(\w+)/);
          const verdict = m ? m[1] : 'UNKNOWN';
          if (verdict === 'SENT') return { success: true, data: `Sent to ${name}` };
          return { success: false, error: `WhatsApp send not confirmed — ${data}` };
        });
      }

      case 'whatsapp-debug-ui': {
        // Dump the WhatsApp window's accessibility tree by recursive walk
        // (entire contents returns 0 on this Catalyst app). Output lines:
        //   <indent><AXRole> | name=<name> | val=<value-truncated>
        return run(`on dumpElement(el, depth, maxDepth, accum)
  if depth > maxDepth then return accum
  set indent to ""
  repeat depth times
    set indent to indent & "  "
  end repeat
  tell application "System Events"
    try
      set r to ""
      try
        set r to (value of attribute "AXRole" of el) as string
      end try
      set n to ""
      try
        set n to (name of el) as string
      end try
      if n is missing value then set n to ""
      set v to ""
      try
        set v to (value of el) as string
      end try
      if v is missing value then set v to ""
      if (count of v) > 80 then set v to (text 1 thru 80 of v) & "..."
      set accum to accum & indent & r & " | name=" & n & " | val=" & v & linefeed
      try
        repeat with k in (UI elements of el)
          set accum to my dumpElement(k, depth + 1, maxDepth, accum)
        end repeat
      end try
    end try
  end tell
  return accum
end dumpElement

tell application "WhatsApp" to activate
delay 0.6
tell application "System Events"
  tell process "WhatsApp"
    set frontmost to true
    delay 0.3
    set out to ""
    repeat with k in (UI elements of window 1)
      set out to my dumpElement(k, 0, 14, out)
    end repeat
    return out
  end tell
end tell`);
      }

      case 'whatsapp-search': {
        const p = typeof params === 'string' ? JSON.parse(params) : params;
        const name = p.contact || p.name || params;
        return new Promise((resolve) => {
          exec(`open -a WhatsApp`, (err) => {
            if (err) { resolve({ success: false, error: err.message }); return; }
            setTimeout(() => {
              exec(`osascript -e '
                tell application "WhatsApp" to activate
                delay 0.5
                tell application "System Events"
                  tell process "WhatsApp"
                    keystroke "f" using command down
                    delay 0.3
                    keystroke "${name}"
                  end tell
                end tell'`, (err2) => {
                resolve({ success: !err2, data: `Searching WhatsApp for ${name}` });
              });
            }, 1000);
          });
        });
      }

      case 'imessage-send': {
        const p = typeof params === 'string' ? JSON.parse(params) : params;
        const contacts = {
          'robert': '+31600000001', 'mandy': '+31600000002', 'danny': '+31600000003',
          'jean-marc': '+31600000004', 'jay': '+31600000005', 'guyen': '+31600000006',
        };
        let number = p.number || contacts[(p.contact || '').toLowerCase()];
        if (!number) return { success: false, error: `Contact "${p.contact}" not found` };
        const msg = (p.message || '').replace(/"/g, '\\"');
        return run(`tell application "Messages"
          set targetService to 1st account whose service type = iMessage
          set targetBuddy to participant "${number}" of targetService
          send "${msg}" to targetBuddy
        end tell`);
      }

      case 'email-send': {
        const p = typeof params === 'string' ? JSON.parse(params) : params;
        const to = p.to || '';
        const subject = encodeURIComponent(p.subject || '');
        const body = encodeURIComponent(p.body || '');
        return shell(`open "mailto:${to}?subject=${subject}&body=${body}"`);
      }

      case 'email-check': {
        return run(`tell application "Mail"
          set unreadCount to unread count of inbox
          if unreadCount = 0 then
            return "No unread emails"
          else
            set msgs to ""
            set unreadMsgs to (messages of inbox whose read status is false)
            set maxShow to 5
            if (count of unreadMsgs) < maxShow then set maxShow to (count of unreadMsgs)
            repeat with i from 1 to maxShow
              set m to item i of unreadMsgs
              set msgs to msgs & sender of m & ": " & subject of m & "\\n"
            end repeat
            return (unreadCount as string) & " unread emails. Latest:\\n" & msgs
          end if
        end tell`);
      }

      // === DO NOT DISTURB ===
      case 'dnd-on':  return shell(`shortcuts run "Turn On Focus" 2>/dev/null || echo "Focus shortcut not found"`);
      case 'dnd-off': return shell(`shortcuts run "Turn Off Focus" 2>/dev/null || echo "Focus shortcut not found"`);

      // === CLIPBOARD ===
      case 'clipboard-get': return shell(`pbpaste`);
      case 'clipboard-set': return shell(`echo "${params}" | pbcopy && echo "Copied to clipboard"`);

      // === CALENDAR ===
      case 'todays-events':
        return run(`tell application "Calendar"
          set today to current date
          set tomorrow to today + 1 * days
          set eventList to ""
          repeat with cal in calendars
            set evts to (every event of cal whose start date >= today and start date < tomorrow)
            repeat with e in evts
              set eventList to eventList & summary of e & " at " & time string of start date of e & "\\n"
            end repeat
          end repeat
          if eventList = "" then return "No events today"
          return eventList
        end tell`);

      default:
        console.log('Unknown mac control:', action);
        return { success: false, error: 'Unknown action: ' + action };
    }
  });
}

module.exports = { registerControls };

/* Claude Code for Zotero — Zotero 7+ bootstrap plugin */
var ClaudeCode;
var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  ClaudeCode = {
    id, version, rootURI,
    PREF: "extensions.claude-code.",
    busy: new Set(),
    menuIDs: [],

    pref(k) { return Zotero.Prefs.get(this.PREF + k, true); },

    log(msg) { Zotero.debug("[claude-code] " + msg); },

    // ---- locating the claude binary -------------------------------------
    async findBinary() {
      let custom = this.pref("binary");
      if (custom) return custom;
      let home = Services.dirsvc.get("Home", Ci.nsIFile).path;
      for (let p of [
        PathUtils.join(home, ".local", "bin", "claude"),
        PathUtils.join(home, ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ]) {
        if (await IOUtils.exists(p)) return p;
      }
      throw new Error("claude binary not found; set extensions.claude-code.binary in Config Editor");
    },

    // ---- running claude -p, fully in the background ----------------------
    async runClaude(prompt) {
      let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      let bin = await this.findBinary();
      let args = ["-p", "--output-format", "text"];
      let tools = this.pref("allowedTools");
      if (tools) args.push("--allowedTools", tools);
      let model = this.pref("model");
      if (model) args.push("--model", model);
      let dir = PathUtils.join(Zotero.DataDirectory.dir, "claude-code");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      let proc = await Subprocess.call({
        command: bin,
        arguments: args,
        workdir: dir,
        environment: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
        environmentAppend: true,
        stderr: "stdout",
      });
      await proc.stdin.write(prompt);
      await proc.stdin.close();
      let out = "", chunk;
      while ((chunk = await proc.stdout.readString())) out += chunk;
      let { exitCode } = await proc.wait();
      if (exitCode !== 0) throw new Error(out.trim() || "claude exited " + exitCode);
      return out.trim();
    },

    // ---- context gathering ----------------------------------------------
    describeParent(item) {
      let att = item.isAnnotation() ? item.parentItem : item.isAttachment() ? item : null;
      let reg = (att && att.parentItem) || (item.isRegularItem() ? item : item.parentItem);
      if (!reg) return { reg: null, text: "" };
      let f = (k) => reg.getField(k);
      return {
        reg,
        text: `Paper: ${f("title")}\nAuthors: ${reg.getCreators().map(c => c.lastName).join(", ")}\nYear: ${f("date")}\nDOI: ${f("DOI")}\nAbstract: ${f("abstractNote")}`,
      };
    },

    fmtAnnotation(a) {
      let t = a.annotationText || "", c = a.annotationComment || "";
      return `[p.${a.annotationPageLabel || "?"} ${a.annotationType}] ${t}${c ? "\n  my note: " + c : ""}`;
    },

    // ---- main entry ------------------------------------------------------
    async ask(items, extra = {}) {
      let key = items.map(i => i.id).join(",") + (extra.text || "");
      if (this.busy.has(key)) return;
      this.busy.add(key);
      try {
        let first = items[0];
        let { reg, text } = this.describeParent(first);
        if (!reg) throw new Error("no parent item to attach the answer to");
        let parts = [], instruction = "";
        for (let it of items) {
          if (it.isAnnotation()) {
            parts.push(this.fmtAnnotation(it));
            // a comment starting with @claude acts as the instruction
            let m = (it.annotationComment || "").match(/^@claude\s+([\s\S]+)/i);
            if (m) instruction = m[1];
          } else if (it.isNote()) {
            let n = it.getNote().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            parts.push("Note: " + n);
            let m = n.match(/@claude\s+([\s\S]+)/i);
            if (m) instruction = m[1];
          }
        }
        if (extra.text) parts.push(`[selection] ${extra.text}`);
        if (!instruction) instruction = this.pref("defaultPrompt");
        let prompt = `${text}\n\nHighlights / notes:\n${parts.join("\n")}\n\nTask: ${instruction}`;
        this.log("asking: " + instruction);
        let answer = await this.runClaude(prompt);
        await this.writeNote(reg, instruction, parts, answer);
        await this.markDone(items);
        this.log("answer saved under item " + reg.id);
      } catch (e) {
        this.log(e.stack || e);
        let pw = new Zotero.ProgressWindow({ closeOnClick: true });
        pw.changeHeadline("Claude Code");
        pw.addDescription(String(e.message || e));
        pw.show(); pw.startCloseTimer(6000);
      } finally {
        this.busy.delete(key);
      }
    },

    // ---- silent trigger: "@claude ..." typed in an annotation comment or note
    TRIGGER: /^\s*@claude\b/i,
    timers: new Map(),

    hasTrigger(item) {
      if (item.isAnnotation()) return this.TRIGGER.test(item.annotationComment || "");
      if (item.isNote()) return /(^|>)\s*@claude\b/i.test(item.getNote());
      return false;
    },

    // After answering, turn "@claude" into "#claude" so it won't fire again
    async markDone(items) {
      for (let it of items) {
        if (!this.hasTrigger(it)) continue;
        if (it.isAnnotation()) {
          it.annotationComment = it.annotationComment.replace(this.TRIGGER, m => m.replace(/@claude/i, "#claude"));
        } else {
          it.setNote(it.getNote().replace(/(^|>)(\s*)@claude\b/i, "$1$2#claude"));
        }
        await it.saveTx({ skipSelect: true });
      }
    },

    observer: {
      notify(event, type, ids) {
        if (type !== "item" || (event !== "add" && event !== "modify")) return;
        for (let id of ids) {
          let item = Zotero.Items.get(id);
          if (!item || !ClaudeCode.hasTrigger(item)) continue;
          // comments/notes save while typing; wait until the user stops
          clearTimeout(ClaudeCode.timers.get(id));
          ClaudeCode.timers.set(id, setTimeout(() => {
            ClaudeCode.timers.delete(id);
            let fresh = Zotero.Items.get(id);
            if (fresh && ClaudeCode.hasTrigger(fresh)) ClaudeCode.ask([fresh]);
          }, 4000));
        }
      },
    },

    esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },

    async writeNote(reg, instruction, parts, answer) {
      let note = new Zotero.Item("note");
      note.libraryID = reg.libraryID;
      note.parentID = reg.id;
      let body = answer.split(/\n{2,}/).map(p => `<p>${this.esc(p).replace(/\n/g, "<br/>")}</p>`).join("");
      note.setNote(
        `<h2>Claude Code</h2><blockquote>${this.esc(parts.join("\n")).replace(/\n/g, "<br/>")}</blockquote>` +
        `<p><em>${this.esc(instruction)}</em></p>${body}`
      );
      note.addTag("claude");
      await note.saveTx();
    },

    // ---- reader hooks ----------------------------------------------------
    readerAnnotationMenu(event) {
      let { reader, params, append } = event;
      // params lives in the reader's content scope: copy it into plain chrome
      // values now, so onCommand never makes content code call back into us
      // (e.g. content Array#map invoking our callback is denied by Firefox).
      let ids = Array.from(params.ids, String);
      let libraryID = reader._item.libraryID;
      append({
        label: "Ask Claude Code",
        onCommand() {
          let items = ids.map(id => Zotero.Items.getByLibraryAndKey(libraryID, id)).filter(Boolean);
          if (items.length) ClaudeCode.ask(items);
        },
      });
    },

    readerSelectionPopup(event) {
      let { reader, doc, params, append } = event;
      let btn = doc.createElement("button");
      btn.textContent = "Ask Claude";
      btn.style.cssText = "width:100%;margin-top:4px";
      let att = reader._item;
      let text = String(params.annotation?.text || "");
      btn.addEventListener("click", () => ClaudeCode.ask([att], { text }));
      append(btn);
    },

    // ---- main window menu ------------------------------------------------
    addToWindow(window) {
      let doc = window.document;
      let menu = doc.getElementById("zotero-itemmenu");
      if (!menu) return;
      let mi = doc.createXULElement("menuitem");
      mi.id = "claude-code-item-menu";
      mi.setAttribute("label", "Ask Claude Code");
      mi.addEventListener("command", () => {
        let sel = window.ZoteroPane.getSelectedItems();
        let targets = [];
        for (let it of sel) {
          if (it.isNote()) targets.push(it);
          else if (it.isRegularItem()) {
            for (let a of it.getAttachments()) {
              let att = Zotero.Items.get(a);
              targets.push(...att.getAnnotations());
            }
          } else if (it.isAttachment()) targets.push(...it.getAnnotations());
        }
        if (targets.length) ClaudeCode.ask(targets);
      });
      menu.appendChild(mi);
      this.menuIDs.push(mi.id);
    },

    removeFromWindow(window) {
      for (let id of this.menuIDs) window.document.getElementById(id)?.remove();
    },
  };

  // Zotero.Reader listeners must be registered after Zotero is ready
  await Zotero.initializationPromise;
  ClaudeCode.observerID = Zotero.Notifier.registerObserver(ClaudeCode.observer, ["item"], "claude-code");
  Zotero.Reader.registerEventListener("createAnnotationContextMenu", ClaudeCode.readerAnnotationMenu, id);
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", ClaudeCode.readerSelectionPopup, id);
  for (let w of Zotero.getMainWindows()) ClaudeCode.addToWindow(w);
}

function onMainWindowLoad({ window }) { ClaudeCode?.addToWindow(window); }
function onMainWindowUnload({ window }) { ClaudeCode?.removeFromWindow(window); }

function shutdown() {
  if (!ClaudeCode) return;
  Zotero.Notifier.unregisterObserver(ClaudeCode.observerID);
  for (let t of ClaudeCode.timers.values()) clearTimeout(t);
  Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", ClaudeCode.readerAnnotationMenu);
  Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", ClaudeCode.readerSelectionPopup);
  for (let w of Zotero.getMainWindows()) ClaudeCode.removeFromWindow(w);
  ClaudeCode = undefined;
}

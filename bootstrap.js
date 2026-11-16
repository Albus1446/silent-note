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

    // Also appended to <Zotero data dir>/claude-code/claude-code.log
    log(msg) {
      Zotero.debug("[claude-code] " + msg);
      let file = PathUtils.join(Zotero.DataDirectory.dir, "claude-code", "claude-code.log");
      IOUtils.writeUTF8(file, `${new Date().toISOString()} ${msg}\n`, { mode: "appendOrCreate" }).catch(e => Zotero.debug("[claude-code] log write failed: " + e));
    },

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
    async runClaude(prompt, readDirs = []) {
      let { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      let bin = await this.findBinary();
      let args = ["-p", "--output-format", "text"];
      let tools = this.pref("allowedTools");
      if (tools) args.push("--allowedTools", tools);
      let model = this.pref("model");
      if (model) args.push("--model", model);
      for (let d of readDirs) args.push("--add-dir", d);
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
      let reg = (att && att.parentItem) || (item.isRegularItem() ? item : null);
      if (!reg) {
        // standalone PDF (no parent item): describe the file itself; the
        // answer becomes a standalone note related to it
        if (!att) return { reg: null, text: "" };
        return { reg: att, text: `Document: ${att.getField("title")}\nFile: ${att.attachmentFilename || ""}` };
      }
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

    // zotero://open-pdf link that jumps back to the annotation in the reader
    annotationLink(it) {
      let att = it.parentItem;
      let lib = Zotero.Libraries.get(it.libraryID);
      let base = lib.libraryType === "group" ? `groups/${lib.groupID}` : "library";
      return `zotero://open-pdf/${base}/items/${att.key}?annotation=${it.key}`;
    },

    // Image/ink annotations have a PNG render in Zotero's own cache
    // (<data dir>/cache/library/KEY.png). Claude reads it there via --add-dir,
    // so nothing is copied. Returns the absolute path or null.
    async annotationImage(it) {
      if (!["image", "ink"].includes(it.annotationType)) return null;
      try {
        let src = Zotero.Annotations.getCacheImagePath(it);
        if (!(await IOUtils.exists(src)) && it.parentItem?.isPDFAttachment()) {
          await Zotero.PDFWorker.renderAttachmentAnnotations(it.parentItemID);
        }
        return (await IOUtils.exists(src)) ? src : null;
      } catch (e) {
        this.log("no image for " + it.key + ": " + e);
        return null;
      }
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
        // parts go to claude; sources are what the note shows above the answer
        let parts = [], sources = [], instruction = "", readDirs = new Set();
        for (let it of items) {
          if (it.isAnnotation()) {
            parts.push(this.fmtAnnotation(it));
            let img = await this.annotationImage(it);
            if (img) {
              parts.push(`  image of this region: ${img} (open it with the Read tool)`);
              readDirs.add(PathUtils.parent(img));
            }
            // a comment starting with @claude acts as the instruction
            let m = (it.annotationComment || "").match(/^@claude\s+([\s\S]+)/i);
            if (m) instruction = m[1];
            sources.push({
              text: it.annotationText || "",
              comment: m ? "" : it.annotationComment || "",
              color: it.annotationColor,
              page: it.annotationPageLabel,
              href: this.annotationLink(it),
              image: img,
            });
          } else if (it.isNote()) {
            let n = it.getNote().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            parts.push("Note: " + n);
            let m = n.match(/@claude\s+([\s\S]+)/i);
            if (m) instruction = m[1];
            else sources.push({ text: n.length > 300 ? n.slice(0, 300) + "…" : n });
          }
        }
        if (extra.text) {
          parts.push(`[selection] ${extra.text}`);
          sources.push({ text: extra.text });
        }
        if (!instruction) instruction = this.pref("defaultPrompt");
        let prompt = `${text}\n\nHighlights / notes:\n${parts.join("\n")}\n\nTask: ${instruction}\n\n${this.pref("answerStyle")}\n\n${this.TITLE_RULE}`;
        this.log("asking: " + instruction);
        let answer = await this.runClaude(prompt, [...readDirs]);
        await this.writeNote(reg, instruction, sources, answer);
        await this.markDone(items);
        this.log("answer saved under item " + reg.id);
      } catch (e) {
        this.log(`${e}\n${e.stack || ""}`);
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
          ClaudeCode.log(`@claude trigger seen on item ${id}; waiting for typing to stop`);
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

    // Minimal markdown -> note HTML: headings, lists, bold/italic/code, paragraphs
    mdToHtml(md) {
      let inline = s => this.esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      let html = [], list = null, para = [], table = null;
      let flushPara = () => { if (para.length) html.push(`<p>${para.map(inline).join("<br/>")}</p>`); para = []; };
      let closeList = () => { if (list) html.push(`</${list}>`); list = null; };
      let cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      let flushTable = () => {
        if (!table) return;
        let [head, ...rows] = table.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c)));
        html.push("<table><tr>" + head.map(c => `<th>${inline(c)}</th>`).join("") + "</tr>" +
          rows.map(r => "<tr>" + r.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</table>");
        table = null;
      };
      for (let line of md.split("\n")) {
        let m;
        if (/^\s*\|.*\|\s*$/.test(line)) {
          flushPara(); closeList();
          (table ||= []).push(cells(line));
          continue;
        }
        flushTable();
        if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
          flushPara(); closeList();
          html.push("<hr/>");
        } else if ((m = line.match(/^>\s?(.*)/))) {
          flushPara(); closeList();
          html.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
        } else if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
          flushPara(); closeList();
          let n = Math.max(3, m[1].length); // h2 is the note title
          html.push(`<h${n}>${inline(m[2])}</h${n}>`);
        } else if ((m = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)/))) {
          flushPara();
          let tag = m[1] ? "ul" : "ol";
          if (list !== tag) { closeList(); html.push(`<${tag}>`); list = tag; }
          html.push(`<li>${inline(m[2])}</li>`);
        } else if (!line.trim()) {
          flushPara(); closeList();
        } else {
          closeList(); para.push(line);
        }
      }
      flushTable(); flushPara(); closeList();
      return html.join("");
    },

    esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },

    // Note layout:
    //   ## <conversation name>              (Claude-generated TITLE line; fallback: comment/question/highlight)
    //   Claude · date · p.N
    //   > “highlight” (in its own colour)  p.N ↗   + embedded figure / your comment
    //   ---
    //   <answer>
    // Asked of every answer, independent of the user-editable answerStyle pref
    TITLE_RULE: "Before everything else, output one line `TITLE: <name>`: a short, specific name for this conversation " +
      "(like a chat title) that says what was actually discussed, e.g. `TITLE: 惠更斯原理与其历史贡献`. " +
      "Same language as the answer, at most 20 Chinese characters or 8 English words, no quotes, no trailing punctuation.",

    // Pull the "TITLE: ..." line off the answer; returns [title|null, rest]
    splitTitle(answer) {
      let m = answer.match(/^\s*(?:#+\s*)?(?:\*\*)?(?:TITLE|标题)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+?)(?:\*\*)?\s*(?:\n|$)/i);
      if (!m) return [null, answer];
      let t = m[1].replace(/^["“'`]+|["”'`。.]+$/g, "").trim();
      return [t || null, answer.slice(m[0].length).trim()];
    },

    clip(s, n) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; },

    async writeNote(reg, instruction, sources, answer) {
      let [named, body] = this.splitTitle(answer);
      answer = body;
      let custom = instruction !== this.pref("defaultPrompt");
      let fallback = sources.find(s => s.comment)?.comment || (custom && instruction) || sources.find(s => s.text)?.text || "Claude";
      let title = named || this.clip(fallback, 40);
      let pages = [...new Set(sources.map(s => s.page).filter(Boolean))];
      let when = new Date().toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      let model = String(this.pref("model") || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
      let meta = ["Claude" + (model ? " " + model : ""), when, pages.length && "p." + pages.join(", ")]
        .filter(Boolean).join(" · ");

      let quotes = sources.map((s, i) => {
        let html = "";
        if (s.text) {
          let bg = s.color ? ` style="background-color: ${s.color}80"` : "";
          html += `<p><span${bg}>“${this.esc(s.text)}”</span>`;
          if (s.href) html += ` <a href="${this.esc(s.href)}">p.${this.esc(s.page || "?")} ↗</a>`;
          html += `</p>`;
        } else if (s.href) {
          html += `<p><a href="${this.esc(s.href)}">Figure, p.${this.esc(s.page || "?")} ↗</a></p>`;
        }
        if (s.image) html += `@@IMG${i}@@`;
        if (s.comment) html += `<p>✎ ${this.esc(s.comment)}</p>`;
        return html;
      }).join("");

      if (custom) quotes += `<p><strong>问：</strong>${this.esc(instruction)}</p>`;

      let html = `<h2>${this.esc(title)}</h2>` +
        `<p><span style="color: #888888">${this.esc(meta)}</span></p>` +
        (quotes ? `<blockquote>${quotes}</blockquote>` : "") +
        `<hr/>${this.mdToHtml(answer)}`;

      let note = new Zotero.Item("note");
      note.libraryID = reg.libraryID;
      let standalone = !reg.isRegularItem();
      if (standalone) note.setCollections(reg.getCollections());
      else note.parentID = reg.id;
      note.setNote(html.replace(/@@IMG\d+@@/g, ""));
      note.addTag("claude");
      await note.saveTx();
      if (standalone) {
        // link note <-> PDF both ways so it shows under "Related"
        note.addRelatedItem(reg);
        reg.addRelatedItem(note);
        await note.saveTx({ skipSelect: true });
        await reg.saveTx({ skipSelect: true });
      }

      // embed figures as note attachments (needs the saved note's id)
      if (sources.some(s => s.image)) {
        let win = Zotero.getMainWindow();
        for (let [i, s] of sources.entries()) {
          if (!s.image) continue;
          let img = "";
          try {
            let blob = new win.Blob([await IOUtils.read(s.image)], { type: "image/png" });
            let att = await Zotero.Attachments.importEmbeddedImage({ blob, parentItemID: note.id });
            img = `<p><img data-attachment-key="${att.key}"/></p>`;
          } catch (e) {
            this.log("could not embed image: " + e);
          }
          html = html.replace(`@@IMG${i}@@`, img);
        }
        note.setNote(html);
        await note.saveTx();
      }
    },

    // ---- reader hooks ----------------------------------------------------
    readerAnnotationMenu(event) {
      ClaudeCode.log("adding reader annotation menu item");
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
      mi.addEventListener("command", () => this.askLibrarySelection(window));
      menu.appendChild(mi);
      this.menuIDs.push(mi.id);
      window.addEventListener("keydown", this.onKeyDown, true);
    },

    removeFromWindow(window) {
      for (let id of this.menuIDs) window.document.getElementById(id)?.remove();
      window.removeEventListener("keydown", this.onKeyDown, true);
    },

    askLibrarySelection(window) {
      let targets = [];
      for (let it of window.ZoteroPane.getSelectedItems()) {
        if (it.isNote()) targets.push(it);
        else if (it.isRegularItem()) {
          for (let a of it.getAttachments()) {
            let att = Zotero.Items.get(a);
            if (att.isFileAttachment()) targets.push(...att.getAnnotations());
          }
        } else if (it.isFileAttachment()) targets.push(...it.getAnnotations());
      }
      if (targets.length) this.ask(targets);
      else this.log("hotkey: nothing selected to send");
    },

    // ---- hotkey (default ⌘⇧E / Ctrl+Shift+E) --------------------------------
    // In the reader: selected annotations, else selected text.
    // In the library: the selected items (same as the context menu).
    onKeyDown(event) {
      let key = String(ClaudeCode.pref("shortcutKey") || "E").toUpperCase();
      let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
      if (!accel || !event.shiftKey || event.altKey || event.key.toUpperCase() !== key) return;
      event.preventDefault();
      event.stopPropagation();
      let win = event.currentTarget;
      let reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (!reader) return ClaudeCode.askLibrarySelection(win);
      ClaudeCode.askReaderSelection(reader);
    },

    askReaderSelection(reader) {
      let att = reader._item;
      let internal = reader._internalReader;
      // copy content-scope values into plain chrome strings before using them
      let ids = Array.from(internal?._state?.selectedAnnotationIDs || [], String);
      let items = ids.map(id => Zotero.Items.getByLibraryAndKey(att.libraryID, id)).filter(Boolean);
      if (items.length) return this.ask(items);

      let view = internal?._lastView || internal?._primaryView;
      let text = "";
      try {
        let ranges = view?._selectionRanges;
        if (ranges?.length) text = Array.from(ranges, r => String(r.text || "")).join("\n");
        if (!text) text = String(view?._iframeWindow?.getSelection()?.toString() || "");
      } catch (e) {
        this.log("hotkey: could not read selection: " + e);
      }
      text = text.trim();
      if (text) return this.ask([att], { text });
      this.log("hotkey: select an annotation or some text first");
    },
  };

  // Zotero.Reader listeners must be registered after Zotero is ready
  await Zotero.initializationPromise;
  await IOUtils.makeDirectory(PathUtils.join(Zotero.DataDirectory.dir, "claude-code"), { ignoreExisting: true });
  ClaudeCode.observerID = Zotero.Notifier.registerObserver(ClaudeCode.observer, ["item"], "claude-code");
  Zotero.Reader.registerEventListener("createAnnotationContextMenu", ClaudeCode.readerAnnotationMenu, id);
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", ClaudeCode.readerSelectionPopup, id);
  for (let w of Zotero.getMainWindows()) ClaudeCode.addToWindow(w);
  ClaudeCode.log(`started v${version}`);
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

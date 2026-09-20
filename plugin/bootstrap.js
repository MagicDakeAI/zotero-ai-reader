var AIReader;
var AIReaderService;

function install() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "content/service.js");
  Services.scriptloader.loadSubScript(rootURI + "vendor/katex/katex.min.js");
  Services.scriptloader.loadSubScript(rootURI + "content/ai-reader.js");
  await AIReaderService.init();
  Zotero.AIReaderService = AIReaderService;
  Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    stylesheets: [rootURI + "preferences.css"],
  });
  AIReader.init({ id, version, rootURI });
}

function shutdown() {
  AIReader?.shutdown();
  AIReaderService?.shutdown();
  delete Zotero.AIReaderService;
  AIReader = null;
  AIReaderService = null;
}

function uninstall() {}

/**
 * The editor side of the editor protocol between h5p-service and Conductor.
 *
 * The page at /h5p/{id}/edit or /h5p/new/edit runs H5P's own editor and is
 * framed by Conductor's edit screen. Everything Conductor needs crosses
 * postMessage, as objects with a `type`, never to "*". The full protocol is in
 * H5P_AUTHORING_DESIGN.md section 3 in the migration workspace:
 *
 *   editor -> parent  ready, loaded, title, dirty, token-expiring, saved,
 *                     save-failed, height, error
 *   parent -> editor  token, save
 *
 * The editor does not start until the first token arrives, so no request ever
 * leaves without one. Configuration arrives through `__LIBRETEXTS_EDITOR__`,
 * built by src/editor/renderer.ts.
 *
 * This file is served statically and never compiled, like embed.js.
 */
(function () {
  "use strict";

  var settings = window.__LIBRETEXTS_EDITOR__ || {};
  // The real parent, Conductor. The editor page may have pointed
  // window.parent at itself for H5P's sake; see src/editor/renderer.ts.
  var conductor = window.__LIBRETEXTS_PARENT__ || window.parent;
  var allowedOrigins = settings.parentOrigins || [];
  var pageContentId = settings.contentId || null;

  var parentOrigin = null; // fixed by the first accepted message
  var claims = null; // decoded payload of the current token, not verified here
  var expiryTimer = null;
  var h5peditor = null;
  var booted = false;
  var loadedSent = false;
  var baseline = null; // serialized parameters at load or last save
  var lastTitle = null;
  var lastDirty = null;
  var inputDirty = false;
  var POLL_MS = 1000;
  var EXPIRY_WARNING_MS = 2 * 60 * 1000;

  function post(message) {
    if (parentOrigin) {
      conductor.postMessage(message, parentOrigin);
      return;
    }
    // Before the parent has spoken, which allowed origin framed us is unknown.
    // A message to a non-matching target origin is dropped by the browser, so
    // announcing to each is safe.
    for (var i = 0; i < allowedOrigins.length; i++) {
      conductor.postMessage(message, allowedOrigins[i]);
    }
  }

  /** Reads a JWT's claims for timing and routing. The server verifies it. */
  function decodeClaims(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (part.length % 4) part += "=";
      return JSON.parse(atob(part));
    } catch (e) {
      return null;
    }
  }

  function acceptToken(token) {
    var decoded = decodeClaims(token);
    if (!decoded || typeof decoded.exp !== "number") {
      post({ type: "error", reason: "bad-token" });
      return false;
    }
    if (pageContentId && decoded.cid !== undefined && String(decoded.cid) !== pageContentId) {
      // A token for another activity would save into the wrong content.
      post({ type: "error", reason: "token-mismatch" });
      return false;
    }
    window.__LIBRETEXTS_EDITOR_TOKEN__ = token;
    claims = decoded;
    if (expiryTimer) clearTimeout(expiryTimer);
    var wait = decoded.exp * 1000 - Date.now() - EXPIRY_WARNING_MS;
    expiryTimer = setTimeout(function () {
      post({ type: "token-expiring" });
    }, Math.max(0, wait));
    return true;
  }

  function editorParams() {
    if (!h5peditor || !h5peditor.selector) return null;
    try {
      return h5peditor.getParams(true);
    } catch (e) {
      return null;
    }
  }

  function currentDisplayOptions() {
    return settings.displayOptions || null;
  }

  function onEditorFrameLoaded() {
    // H5P commits a field's value on change, not per keystroke, so polling
    // alone misses typing in progress. Any input flags unsaved changes at once
    // (spike 3).
    try {
      this.document.addEventListener(
        "input",
        function () {
          inputDirty = true;
          report();
        },
        true
      );
    } catch (e) {
      /* the frame was replaced; the next load reattaches */
    }
  }

  function report() {
    var params = editorParams();
    if (!params) return;
    var json = JSON.stringify(params);
    if (baseline === null) {
      baseline = json;
      inputDirty = false;
    }
    if (!loadedSent) {
      loadedSent = true;
      post({
        type: "loaded",
        title: (params.metadata && params.metadata.title) || "",
        library: safeLibrary(),
        displayOptions: currentDisplayOptions(),
      });
    }
    var title = (params.metadata && params.metadata.title) || "";
    if (title !== lastTitle) {
      lastTitle = title;
      post({ type: "title", title: title });
    }
    var dirty = inputDirty || json !== baseline;
    if (dirty !== lastDirty) {
      lastDirty = dirty;
      post({ type: "dirty", dirty: dirty });
    }
  }

  function safeLibrary() {
    try {
      return h5peditor.getLibrary() || null;
    } catch (e) {
      return null;
    }
  }

  function boot() {
    if (booted) return;
    booted = true;
    var ns = window.H5PEditor;
    var $ = window.H5P.jQuery;
    var integration = window.H5PIntegration.editor;
    ns.$ = $;
    ns.basePath = integration.libraryUrl;
    ns.fileIcon = integration.fileIcon;
    ns.ajaxPath = integration.ajaxPath;
    ns.filesPath = integration.filesPath;
    ns.apiVersion = integration.apiVersion;
    ns.contentLanguage = integration.language;
    ns.copyrightSemantics = integration.copyrightSemantics;
    ns.metadataSemantics = integration.metadataSemantics;
    ns.assets = integration.assets;
    ns.baseUrl = "";
    ns.getAjaxUrl = function (action, parameters) {
      var url = integration.ajaxPath + action;
      if (parameters !== undefined) {
        for (var key in parameters) {
          if (Object.prototype.hasOwnProperty.call(parameters, key)) {
            url += "&" + key + "=" + encodeURIComponent(parameters[key]);
          }
        }
      }
      return url;
    };
    if (integration.nodeVersionId !== undefined) ns.contentId = integration.nodeVersionId;

    var mount = document.querySelector(".h5p-editor");
    if (pageContentId) {
      $.ajax({
        url: settings.paramsUrl,
        dataType: "json",
        success: function (res) {
          h5peditor = new ns.Editor(res.library, JSON.stringify(res.params), mount, onEditorFrameLoaded);
        },
        error: function (xhr) {
          post({ type: "error", reason: "load-failed", status: xhr.status });
        },
      });
    } else {
      h5peditor = new ns.Editor(undefined, undefined, mount, onEditorFrameLoaded);
    }
    setInterval(report, POLL_MS);
  }

  function save(requestId, displayOptions) {
    var contentId = claims && claims.cid !== undefined ? String(claims.cid) : null;
    if (!h5peditor) {
      post({ type: "save-failed", requestId: requestId, reason: "not-loaded" });
      return;
    }
    if (!contentId) {
      // A new activity saves only after Conductor has allocated its id and
      // sent an edit token for it (authoring design, section 4).
      post({ type: "save-failed", requestId: requestId, reason: "no-content-id" });
      return;
    }
    h5peditor.getContent(
      function (content) {
        fetch(settings.saveUrlBase + "/" + encodeURIComponent(contentId) + "/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            library: content.library,
            params: JSON.parse(content.params),
            displayOptions: displayOptions || undefined,
          }),
        })
          .then(function (res) {
            return res
              .json()
              .catch(function () {
                return {};
              })
              .then(function (body) {
                return { status: res.status, body: body };
              });
          })
          .then(function (r) {
            if (r.status !== 200) {
              post({ type: "save-failed", requestId: requestId, reason: "server", status: r.status });
              return;
            }
            var params = editorParams();
            baseline = params ? JSON.stringify(params) : baseline;
            inputDirty = false;
            if (displayOptions) settings.displayOptions = displayOptions;
            post({
              type: "saved",
              requestId: requestId,
              contentId: r.body.contentId,
              title: r.body.title,
              library: r.body.library,
              license: r.body.license,
              licenseVersion: r.body.licenseVersion,
              authors: r.body.authors,
              displayOptions: r.body.displayOptions,
            });
            report();
          })
          .catch(function () {
            post({ type: "save-failed", requestId: requestId, reason: "network" });
          });
      },
      function (error) {
        // H5P shows its own validation messages beside the fields; the parent
        // only needs to know the save did not happen.
        post({
          type: "save-failed",
          requestId: requestId,
          reason: "validation",
          messages: error ? [String(error)] : [],
        });
      }
    );
  }

  window.addEventListener("message", function (event) {
    if (allowedOrigins.indexOf(event.origin) === -1) return;
    if (parentOrigin && event.origin !== parentOrigin) return;
    var message = event.data;
    if (!message || typeof message !== "object") return;
    parentOrigin = event.origin;

    if (message.type === "token" && typeof message.token === "string") {
      if (acceptToken(message.token)) boot();
    } else if (message.type === "save") {
      save(message.requestId, message.displayOptions);
    }
  });

  if (window.ResizeObserver) {
    var lastHeight = 0;
    new ResizeObserver(function () {
      var height = Math.ceil(document.documentElement.scrollHeight);
      if (height !== lastHeight) {
        lastHeight = height;
        post({ type: "height", height: height });
      }
    }).observe(document.body);
  }

  post({ type: "ready", mode: pageContentId ? "edit" : "new" });
})();

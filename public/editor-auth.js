/**
 * Adds the capability token to the H5P editor's own requests.
 *
 * Loaded twice: by the editor page, and first in the H5P editor's inner
 * iframe, through `H5PIntegration.editor.assets.js`. The inner iframe is where
 * H5P makes every editor AJAX call and file upload, with its own copy of
 * jQuery, so wrapping only the outer page misses all of them (authoring design,
 * section 8, spike 1).
 *
 * The token lives in the editor page's memory as `__LIBRETEXTS_EDITOR_TOKEN__`,
 * put there by editor-page.js when Conductor sends it. The inner iframe is
 * same-origin, so it reads the page's copy. The header is only ever added to
 * same-origin requests, never to a third party.
 *
 * jQuery's ajax and H5P's file uploader both use XMLHttpRequest, so wrapping
 * it and fetch covers everything the editor sends.
 */
(function () {
  "use strict";

  if (window.__LIBRETEXTS_EDITOR_AUTH__) return;
  window.__LIBRETEXTS_EDITOR_AUTH__ = true;

  function token() {
    try {
      return (
        window.__LIBRETEXTS_EDITOR_TOKEN__ ||
        (window.parent && window.parent.__LIBRETEXTS_EDITOR_TOKEN__) ||
        null
      );
    } catch (e) {
      // A cross-origin parent throws on access: that is never the editor page.
      return null;
    }
  }

  function sameOrigin(url) {
    try {
      // The inner iframe is about:blank written by H5P; its base URI is the
      // editor page's, which is the origin to compare against.
      return new URL(url, document.baseURI).origin === new URL(document.baseURI).origin;
    } catch (e) {
      return false;
    }
  }

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__libretextsUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var t = token();
    if (t && sameOrigin(this.__libretextsUrl)) {
      this.setRequestHeader("Authorization", "Bearer " + t);
    }
    return send.apply(this, arguments);
  };

  if (window.fetch) {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      var t = token();
      if (t && sameOrigin(url)) {
        init = init || {};
        var headers = new Headers(init.headers || (typeof input !== "string" && input ? input.headers : undefined));
        headers.set("Authorization", "Bearer " + t);
        init.headers = headers;
      }
      return originalFetch.call(this, input, init);
    };
  }
})();

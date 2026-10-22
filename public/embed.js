/**
 * LibreTexts embed contract.
 *
 * Port of Studio's `lstudio_h5p_mode_external.js` and `lstudio-h5p.js`. Every
 * behaviour here is relied on by something already in production, so treat this
 * file as an external interface rather than application code:
 *
 *   - ADAPT grades activities off the relayed xAPI statements.
 *   - ADAPT restyles the activity through the inbound `elements` / `templates`
 *     messages.
 *   - Published textbook pages size the iframe via the standard H5P resizer.
 *
 * One deliberate change from Studio: inbound messages are now checked against an
 * origin allowlist. Studio accepted DOM-mutation instructions from any origin,
 * which let any page framing an activity rewrite its contents. Outbound posts
 * stay at "*" so existing consumers keep receiving them unchanged.
 */
(function () {
  "use strict";

  /**
   * Every deployment-specific value arrives from the server through this
   * object, injected by `src/embed/renderer.ts`. This file is served
   * statically and never compiled, so it has no other way to be configured.
   */
  var settings = window.__LIBRETEXTS_EMBED__ || {};
  var allowedParentOrigins = settings.allowedParentOrigins || [];
  var adaptReferrers = settings.adaptReferrers || [];
  var trustedParentHosts = settings.trustedParentHosts || [];
  var badge = settings.badge || {};

  /** The origin of a URL, or "" when it cannot be parsed. */
  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return "";
    }
  }

  /** The lowercased host of a URL, or "" when it cannot be parsed. */
  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  /**
   * Studio special-cased ADAPT by comparing `document.referrer` against a list
   * of exact URL strings, which meant a trailing-slash mismatch silently
   * restored the buttons ADAPT wants hidden. Compare origins instead.
   */
  function isAdaptHost(url) {
    return adaptReferrers.indexOf(originOf(url)) !== -1;
  }

  /**
   * Studio tested `url.indexOf("libretexts.org") !== -1`, which also matches
   * `evil-libretexts.org.attacker.com`. Match the host exactly or as a
   * dot-suffix.
   */
  function isTrustedParent(url) {
    var host = hostOf(url);
    if (!host) return false;
    for (var i = 0; i < trustedParentHosts.length; i += 1) {
      var trusted = trustedParentHosts[i];
      if (host === trusted || host.slice(-(trusted.length + 1)) === "." + trusted) {
        return true;
      }
    }
    return false;
  }

  /**
   * Builds the attribution badge with DOM APIs rather than an HTML string.
   * The href, logo and label are operator-supplied, and interpolating them
   * into `insertAdjacentHTML` would be an injection sink the first time one of
   * them came from anywhere less trusted.
   *
   * Returns null when no badge href is configured, so a deployment that sets
   * no branding shows none.
   */
  function buildBadge() {
    if (!badge.href) return null;

    var item = document.createElement("li");
    item.className = "lt-icon";

    var link = document.createElement("a");
    link.className = "lstudio-link";
    link.setAttribute("href", badge.href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener");
    if (badge.label) link.setAttribute("title", badge.label);

    if (badge.logoUrl) {
      var logo = document.createElement("img");
      logo.setAttribute("src", badge.logoUrl);
      logo.setAttribute("alt", "");
      link.appendChild(logo);
    }

    if (badge.label) {
      link.appendChild(document.createTextNode(" " + badge.label));
    }

    item.appendChild(link);
    return item;
  }

  function postToParent(message) {
    try {
      parent.postMessage(message, "*");
    } catch (e) {
      /* A parent that refuses messages must never break playback. */
    }
  }

  function isAllowedOrigin(origin) {
    for (var i = 0; i < allowedParentOrigins.length; i += 1) {
      if (allowedParentOrigins[i] === origin) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Load handshake and host adaptation
  // ---------------------------------------------------------------------------

  window.addEventListener("load", function () {
    // Both forms are sent because Studio sent both and we cannot tell which one
    // each consumer listens for.
    postToParent(JSON.stringify("loaded"));
    postToParent("loaded");

    var actionsBar = document.querySelector(".h5p-actions");
    if (!actionsBar) return;

    var exportBtn = actionsBar.querySelector(".h5p-export");
    var embedBtn = actionsBar.querySelector(".h5p-embed");
    var h5pLink = actionsBar.querySelector(".h5p-link");

    var parentURL =
      parent !== window ? document.referrer : String(document.location);

    if (isAdaptHost(parentURL)) {
      // Inside ADAPT the export, embed and H5P links are noise.
      if (exportBtn) exportBtn.classList.add("hidden");
      if (embedBtn) embedBtn.classList.add("hidden");
      if (h5pLink) h5pLink.classList.add("hidden");
      return;
    }

    if (!isTrustedParent(parentURL)) {
      if (h5pLink) h5pLink.classList.add("hidden");
      var badgeItem = buildBadge();
      if (badgeItem) actionsBar.appendChild(badgeItem);
    }
  });

  // ---------------------------------------------------------------------------
  // Inbound styling API (origin-checked)
  // ---------------------------------------------------------------------------

  window.addEventListener("message", function (event) {
    if (!isAllowedOrigin(event.origin)) return;

    var message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (Object.prototype.hasOwnProperty.call(message, "elements")) {
      message.elements.forEach(function (incoming) {
        if (!incoming || !incoming.selector) return;
        var elements = window.document.querySelectorAll(incoming.selector);
        if (Object.prototype.hasOwnProperty.call(incoming, "style")) {
          elements.forEach(function (el) {
            el.style.cssText = incoming.style;
          });
        }
        if (Object.prototype.hasOwnProperty.call(incoming, "class")) {
          elements.forEach(function (el) {
            el.className = incoming.class;
          });
        }
      });
      if (event.source) {
        event.source.postMessage("updated elements", event.origin);
      }
    }

    if (Object.prototype.hasOwnProperty.call(message, "templates")) {
      message.templates.forEach(function (cssString) {
        var element = document.createElement("style");
        element.innerText = cssString;
        document.head.insertAdjacentElement("beforeend", element);
      });
      if (event.source) {
        event.source.postMessage("updated templates", event.origin);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // xAPI relay
  // ---------------------------------------------------------------------------

  // A silent bail here would disable ADAPT grading with no visible symptom, so
  // say so loudly rather than returning quietly.
  if (typeof H5P === "undefined" || !H5P.externalDispatcher) {
    console.error(
      "[libretexts-embed] H5P.externalDispatcher unavailable; xAPI relay is OFF. " +
        "Grading in ADAPT will not work for this activity."
    );
    return;
  }

  var isQuestionSet = false;

  function checkQuestionType(event) {
    var statement = event.data.statement;
    var categories =
      (statement.context &&
        statement.context.contextActivities &&
        statement.context.contextActivities.category) ||
      [];

    isQuestionSet = categories.some(function (category) {
      return category.id && category.id.indexOf("H5P.QuestionSet") !== -1;
    });

    if (isQuestionSet) {
      postToParent(JSON.stringify({}));
      H5P.externalDispatcher.off("xAPI", checkQuestionType);
    }
  }

  function handleH5PEvent(event) {
    var maxScore;

    if (event.getVerb() === "answered" && isQuestionSet) {
      var progressItems = document.getElementsByClassName("progress-item");
      if (progressItems.length) {
        maxScore = progressItems.length;
      } else {
        var progressText = document.querySelector(".progress-text");
        var match =
          progressText &&
          progressText.textContent.match(
            /Question: (\d+) of (\d+) questions/
          );
        if (match) {
          maxScore = Number(match[2]);
        }
      }
      postToParent(JSON.stringify({ maxScore: maxScore }));
    }

    if (event.getVerb() === "attempted" && H5P.instances[0]) {
      postToParent(
        JSON.stringify({ maxScore: H5P.instances[0].getMaxScore() })
      );
      H5P.externalDispatcher.off("xAPI", handleH5PEvent);
    }
  }

  H5P.externalDispatcher.on("xAPI", handleH5PEvent);
  H5P.externalDispatcher.on("xAPI", checkQuestionType);
  H5P.externalDispatcher.on("xAPI", function (event) {
    // The unconditional relay ADAPT grades against.
    postToParent(JSON.stringify(event.data.statement));
  });
})();

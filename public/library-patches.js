/**
 * Runtime fixes for bugs in H5P content-type libraries.
 *
 * The library files themselves stay byte-identical to what Studio served, so
 * the content bucket remains a plain `aws s3 sync` of Studio's. Fixes go here
 * instead, applied to the library's prototype after its scripts have loaded
 * and before `H5P.init` creates instances on DOM ready. That ordering is why
 * `src/embed/renderer.ts` loads this file at the end of <head>.
 *
 * Each patch must check for its library and do nothing when the library is
 * absent, because this file loads on every embed. Before adding one, confirm
 * the bug is still present in the newest upstream release.
 */
(function () {
  "use strict";

  if (typeof H5P === "undefined") return;

  // ---------------------------------------------------------------------------
  // H5P.FindTheWords 1.4.4: play area locks at its first measured width
  // ---------------------------------------------------------------------------
  //
  // The resize handler sets an inline width on `.h5p-play-area` measured from
  // `.puzzle-container`, which sits inside it. When the content first attaches
  // in a narrow frame (textbook pages embed with `width="100"` until the
  // resizer widens the iframe), every later resize measures the already
  // narrowed box and writes the same width back, so the grid stays squeezed
  // into ~130px. `calculateElementSize` runs first in that handler, so clearing
  // the stale width there lets the measurement see the real layout.
  //
  // ---------------------------------------------------------------------------
  // H5P.FindTheWords 1.4.4: grid overflows narrow screens
  // ---------------------------------------------------------------------------
  //
  // When a cell fitted to the container would be under 32px, the library falls
  // back to its 64px maximum, so a 14-column grid draws 896px wide on a 420px
  // phone. The iframe body hides overflow, leaving the right-hand columns out
  // of reach. Cells shrink to fit instead. Every coordinate and the letter size
  // in the grid code scale with the cell size, so selection keeps working.
  //
  // Upstream (jithin-space/h5p-find-the-words, 1.4.4 on the H5P Hub) has
  // neither fix as of 2026-11. Content 31019 reproduces both.
  var FindTheWords = H5P.FindTheWords;
  if (FindTheWords && FindTheWords.prototype.calculateElementSize) {
    var GRID_MARGIN = 8; // The library's private MARGIN, in px.
    var calculateElementSize = FindTheWords.prototype.calculateElementSize;
    FindTheWords.prototype.calculateElementSize = function () {
      if (this.$playArea) this.$playArea.css("width", "");
      var result = calculateElementSize.apply(this, arguments);

      // A container measured at 0 (hidden at attach) keeps the library's
      // value. The next resize after it is shown recalculates.
      var columns = this.grid.wordGrid[0].length;
      var fitted = Math.floor((this.$container.width() - 2 * GRID_MARGIN) / columns);
      if (fitted > 0 && this.elementSize > fitted) this.elementSize = fitted;
      return result;
    };
  }

  // ---------------------------------------------------------------------------
  // H5P.FindTheWords 1.4.4: drag ends on the wrong row
  // ---------------------------------------------------------------------------
  //
  // `mousedown` measures the pointer from the canvas top, but `mousemove` and
  // `mouseup` subtract `0.75 * cellSize` instead (or the canvas top when that
  // is smaller). A drag only ends on the right row when the canvas happens to
  // sit about that far down the frame. On 31019 that holds at desktop width by
  // coincidence. With phone-sized cells, or a description that wraps, the end
  // cell lands a row off and no word can be selected. Upstream PR #27 fixes the
  // same thing and is unmerged as of 2026-11.
  //
  // The handlers are private to the library, so the event is corrected before
  // they see it: a capture listener shifts `pageY` by the difference between
  // the real canvas top and the one the library assumes. Simulated mouse events
  // from the library's touch handling pass through here too. jQuery 3 reads
  // `pageY` from the native event, so an own property on it takes effect.
  var WordGrid = FindTheWords && FindTheWords.WordGrid;
  if (WordGrid && WordGrid.prototype.drawGrid && typeof WeakMap === "function") {
    var gridsByCanvas = new WeakMap();
    var drawGrid = WordGrid.prototype.drawGrid;
    WordGrid.prototype.drawGrid = function () {
      var result = drawGrid.apply(this, arguments);
      if (this.$drawingCanvas) gridsByCanvas.set(this.$drawingCanvas[0], this);
      return result;
    };

    var correctPointerY = function (event) {
      var grid = gridsByCanvas.get(event.target);
      if (!grid) return;
      var canvasTop = H5P.jQuery(event.target).offset().top;
      var limit = grid.elementSize * 0.75;
      var assumedTop = canvasTop > limit ? Math.floor(limit) : canvasTop;
      Object.defineProperty(event, "pageY", {
        value: event.pageY - (canvasTop - assumedTop),
        configurable: true,
      });
    };
    document.addEventListener("mousemove", correctPointerY, true);
    document.addEventListener("mouseup", correctPointerY, true);
  }
})();

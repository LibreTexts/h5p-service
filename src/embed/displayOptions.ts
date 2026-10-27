/**
 * Which H5P action bar buttons an embed shows, decided the way Studio did.
 *
 * Studio stored each activity's choices in `h5p_content.disabled_features`, a
 * bitmask defined by H5P core (`H5PCore::DISABLE_*` in h5p-php-library 1.27).
 * A set bit hides that feature. Studio's site settings then decided how much
 * of the bitmask applied: frame, copyright and the H5P icon on site-wide, and
 * download and embed "controlled by author, default on", which leaves them to
 * the bits. This reproduces `H5PCore::getDisplayOptionsForView` under those
 * settings.
 *
 * Lumi's player defaults every option to false, so without this every embed
 * loses its action bar, including the Rights of use button that carries the
 * activity's license and attribution.
 */

/** Bits of `disabled_features`, as defined by H5P core. */
export const H5P_DISABLE = {
  FRAME: 1,
  DOWNLOAD: 2,
  EMBED: 4,
  COPYRIGHT: 8,
  /** Ignored for viewing: H5P core shows the icon from the site setting alone. */
  ABOUT: 16,
} as const;

/** The subset of Lumi's `player.render` options this module decides. */
export type EmbedDisplayOptions = {
  showFrame: boolean;
  showDownloadButton: boolean;
  showEmbedButton: boolean;
  showLicenseButton: boolean;
  showH5PIcon: boolean;
  showCopyButton: boolean;
};

/**
 * Render options for an activity, from its stored bitmask. Content with no
 * stored value, such as content created after the migration, gets H5P's
 * default for new content: everything on.
 */
export function displayOptionsForView(disabledFeatures?: number | null): EmbedDisplayOptions {
  const bits = Number.isInteger(disabledFeatures) ? (disabledFeatures as number) : 0;
  return {
    showFrame: !(bits & H5P_DISABLE.FRAME),
    showDownloadButton: !(bits & H5P_DISABLE.DOWNLOAD),
    showEmbedButton: !(bits & H5P_DISABLE.EMBED),
    showLicenseButton: !(bits & H5P_DISABLE.COPYRIGHT),
    showH5PIcon: true,
    // H5P core grants Copy only to people who can edit the content. Embeds
    // are always rendered for an anonymous viewer, so it stays off.
    showCopyButton: false,
  };
}

/**
 * The four choices an author makes on the edit screen. `true` shows the
 * feature. Same meaning as the Display options checkboxes in the design.
 */
export type AuthorDisplayOptions = {
  frame: boolean;
  download: boolean;
  embed: boolean;
  copyright: boolean;
};

/** The author's choices as stored, for the edit screen to show. */
export function authorDisplayOptions(disabledFeatures?: number | null): AuthorDisplayOptions {
  const view = displayOptionsForView(disabledFeatures);
  return {
    frame: view.showFrame,
    download: view.showDownloadButton,
    embed: view.showEmbedButton,
    copyright: view.showLicenseButton,
  };
}

/**
 * The author's choices as H5P's bitmask, for storage. Rejects anything but
 * four booleans, so a malformed save cannot silently hide the license.
 */
export function disabledFeaturesFrom(options: unknown): number {
  const o = options as Partial<Record<keyof AuthorDisplayOptions, unknown>> | null;
  const keys: (keyof AuthorDisplayOptions)[] = ["frame", "download", "embed", "copyright"];
  if (!o || typeof o !== "object" || keys.some((k) => typeof o[k] !== "boolean")) {
    throw new Error("displayOptions needs frame, download, embed and copyright as booleans");
  }
  return (
    (o.frame ? 0 : H5P_DISABLE.FRAME) |
    (o.download ? 0 : H5P_DISABLE.DOWNLOAD) |
    (o.embed ? 0 : H5P_DISABLE.EMBED) |
    (o.copyright ? 0 : H5P_DISABLE.COPYRIGHT)
  );
}

/**
 * Lumi's permission checks, answered from capability tokens.
 *
 * Replaces Lumi's default `LaissezFairePermissionSystem`, which allows
 * everything. That default was harmless in phase 1, because only the public
 * routes were mounted. With the editor routes on, it would let anyone create,
 * edit and delete content and install libraries.
 *
 * Public reads stay public: viewing, embedding, downloading and reading
 * parameters needed no rights in Studio, and published textbooks depend on
 * that. Everything that writes needs a token granting that exact action, and
 * for existing content, that exact content id.
 */
import {
  ContentPermission,
  GeneralPermission,
  TemporaryFilePermission,
  UserDataPermission,
  type ContentId,
  type IPermissionSystem,
  type IUser,
} from "@lumieducation/h5p-server";
import type { Capability, CapabilityAction } from "./capabilityToken.js";

/** A Lumi user with the capability its request carried, if any. */
export type CapabilityUser = IUser & { capability?: Capability };

function grants(user: IUser, action: CapabilityAction, contentId?: ContentId): boolean {
  const capability = (user as CapabilityUser).capability;
  if (!capability || !capability.actions.has(action)) return false;
  if (contentId === undefined) return true;
  return capability.contentId === String(contentId);
}

export default class CapabilityPermissionSystem implements IPermissionSystem<IUser> {
  async checkForContent(
    actingUser: IUser,
    permission: ContentPermission,
    contentId: ContentId | undefined
  ): Promise<boolean> {
    switch (permission) {
      case ContentPermission.View:
      case ContentPermission.Embed:
      case ContentPermission.Download:
        return true;
      case ContentPermission.Create:
        // Saving a new activity's first version happens under an `edit` token
        // for the id Conductor allocated (design section 4), so creating
        // content without an id is never needed. `create` only opens the editor.
        return false;
      case ContentPermission.Edit:
        return contentId !== undefined && grants(actingUser, "edit", contentId);
      case ContentPermission.Delete:
        return contentId !== undefined && grants(actingUser, "delete", contentId);
      case ContentPermission.List:
      default:
        return false;
    }
  }

  async checkForUserData(
    _actingUser: IUser,
    _permission: UserDataPermission,
    _contentId: ContentId,
    _affectedUserId?: string
  ): Promise<boolean> {
    // Learner state and results are not stored by this service.
    return false;
  }

  async checkForTemporaryFile(
    actingUser: IUser,
    permission: TemporaryFilePermission,
    _filename: string | undefined
  ): Promise<boolean> {
    if (permission === TemporaryFilePermission.View) {
      // The editor previews unsaved uploads through <img src>, which cannot
      // carry a token. The random part of the file name, and the temp bucket
      // expiring objects after a day, are the protection (design section 8,
      // spike 2).
      return true;
    }
    if (permission === TemporaryFilePermission.List) return false;
    const capability = (actingUser as CapabilityUser).capability;
    return Boolean(capability && (capability.actions.has("edit") || capability.actions.has("create")));
  }

  async checkForGeneralAction(actingUser: IUser, permission: GeneralPermission): Promise<boolean> {
    switch (permission) {
      case GeneralPermission.InstallRecommended:
      case GeneralPermission.UpdateAndInstallLibraries:
      case GeneralPermission.CreateRestricted:
        return grants(actingUser, "libraries");
      default:
        return false;
    }
  }
}

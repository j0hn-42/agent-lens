/**
 * Folder prefix of session tabs (#246). When sessions of several folders are open, two tabs can carry the
 * same label ("fix login"); the folder tells them apart. Only a folder the source proved is shown: the
 * project id and name come from the git common dir, never guessed from the label. Pure (no React).
 */
import { IMPORTED_PROJECT_ID, type SessionInfo } from './bridge-types'

type FolderFields = Pick<SessionInfo, 'projectId' | 'projectName'>

/** Folder name of a session, or null when it is not proven (no git project, or an imported transcript). */
export function sessionFolder(s: FolderFields): string | null {
  if (!s.projectId || s.projectId === IMPORTED_PROJECT_ID) return null
  const name = s.projectName?.trim()
  return name ? name : null
}

/** True when the sessions belong to at least two distinct proven folders (worktrees of one repo count once). */
export function spansSeveralFolders(sessions: ReadonlyArray<FolderFields>): boolean {
  const ids = new Set<string>()
  for (const s of sessions) if (sessionFolder(s) !== null) ids.add(s.projectId!)
  return ids.size > 1
}

/** "folder / label" when several folders are open and this session has a proven one; the label otherwise. */
export function folderPrefixedLabel(session: Pick<SessionInfo, 'label'> & FolderFields, sessions: ReadonlyArray<FolderFields>): string {
  const folder = sessionFolder(session)
  if (folder === null || !spansSeveralFolders(sessions)) return session.label
  if (session.label.toLowerCase().startsWith(folder.toLowerCase())) return session.label
  return `${folder} / ${session.label}`
}

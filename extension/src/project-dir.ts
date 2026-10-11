/**
 * Name of the folder Claude Code uses for a project under ~/.claude/projects.
 * Every character that is not a letter or a digit becomes `-` (so `/`, `\`, `:`, `_`, `.` and
 * non-ASCII characters all do). Past PROJECT_DIR_NAME_MAX characters the name is cut and a hash
 * is appended, which cannot be recomputed here: such a folder is recognised by its prefix.
 */
export const PROJECT_DIR_NAME_MAX = 200

export function encodeProjectDirName(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ProjectDirMatchOptions {
  /** Windows: VS Code and shells say `c:\...` while Claude Code stores `C--...`. */
  caseInsensitive?: boolean
}

/** Matches the folder of `workspacePath` and of its sub-projects (`<encoded>-...`). */
export function projectDirMatcher(
  workspacePath: string,
  opts: ProjectDirMatchOptions = {},
): (dirName: string) => boolean {
  const fold = (s: string) => ((opts.caseInsensitive ?? process.platform === 'win32') ? s.toLowerCase() : s)
  const encoded = fold(encodeProjectDirName(workspacePath))
  if (encoded.length > PROJECT_DIR_NAME_MAX) {
    const prefix = encoded.slice(0, PROJECT_DIR_NAME_MAX)
    return name => fold(name).startsWith(prefix)
  }
  return name => {
    const n = fold(name)
    return n === encoded || n.startsWith(encoded + '-')
  }
}

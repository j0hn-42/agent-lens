# Third-party skills

Skills copied unmodified from the open skills ecosystem (https://skills.sh). Each declares `license: MIT` in its `SKILL.md`. To update one, re-install it elsewhere with the command below and copy the folder over.

| Folder | Source | Re-install |
|---|---|---|
| `accessibility/` | `addyosmani/web-quality-skills` | `npx skills add addyosmani/web-quality-skills@accessibility -g -y` |
| `vercel-react-best-practices/` | `vercel-labs/agent-skills` | `npx skills add vercel-labs/agent-skills@vercel-react-best-practices -g -y` |
| `playwright-best-practices/` | `currents-dev/playwright-best-practices-skill` | `npx skills add currents-dev/playwright-best-practices-skill@playwright-best-practices -g -y` |

Skills written for this project: `run-checks/`, `pr-fork/`.

Deliberately not vendored (keep them user-level if wanted):

- `web-design-guidelines` (vercel-labs): fetches its rules from a remote `main` branch at every run, so its instructions are not pinned.
- `tailwind-4-docs` (lombiq): downloads Tailwind documentation published under a source-available, non-open-source license and runs a sync script.

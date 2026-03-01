# repo-scaffold

Set up a new project with public/private repo separation and clean AI configuration.

## When to Use

User wants to create a new project, scaffold a repo, or set up a workspace with separated public and private content.

## The Pattern

Two sibling repos under one workspace directory:

```
<workspace>/
├── <project>/                # Public repo (GitHub public)
│   ├── src/
│   ├── CLAUDE.md             # Public-facing, constitutional
│   ├── CLAUDE.local.md       # Local dev context (gitignored, CC reads automatically)
│   ├── .claude/
│   │   └── progress.md       # Execution state (gitignored)
│   ├── .gitignore
│   ├── README.md
│   └── LICENSE
└── <project>-backstage/      # Private repo (GitHub private)
    ├── design/               # Design truth
    ├── plan/                 # Execution plans
    └── research/             # Technical references
```

## File Roles

### CLAUDE.md — public, in git
- Constitutional: only stable, rarely-changing content
- Project identity, tech stack, design principles, code conventions
- No internal paths, no backstage references, no progress tracking
- This is what the world sees

### CLAUDE.local.md — private, gitignored, project root
- CC loads this automatically alongside CLAUDE.md (append, local wins on conflict)
- Must live at project root (`./CLAUDE.local.md`), NOT in `.claude/`
- Contains: backstage path, old project references, git workflow

Template:
```markdown
# Local Development Context

## Internal Docs
Design documents and plans live in a sibling private repo:
`../PROJECT-backstage/`

## Execution State
Read `.claude/progress.md` for current phase and next steps.

## Git Workflow
Two repos, two commit flows:
- Code changes → commit here
- Doc changes → commit in `../PROJECT-backstage/`
```

### .claude/progress.md — private, gitignored
- Dynamic execution state: current phase, completed items, next steps, pending research
- Referenced by CLAUDE.local.md, never by CLAUDE.md

### .gitignore must include
```
.claude/
CLAUDE.local.md
node_modules/
dist/
*.tsbuildinfo
.DS_Store
.env
coverage/
```

## Setup Steps

```bash
# 1. Create workspace
mkdir -p ~/motifpool/<project> && cd ~/motifpool/<project>

# 2. Public repo
mkdir <project> && cd <project> && git init

# 3. Private repo
cd .. && mkdir <project>-backstage && cd <project>-backstage && git init

# 4. Create files in public repo
# CLAUDE.md (public identity)
# CLAUDE.local.md (backstage path, gitignored)
# .claude/progress.md (execution state)
# .gitignore (include .claude/ and CLAUDE.local.md)

# 5. Push to GitHub
cd <project>
gh repo create ORG/<project> --public --source=. --push
cd ../<project>-backstage
gh repo create ORG/<project>-backstage --private --source=. --push
```

## Naming Convention

| Item | Name |
|------|------|
| Workspace | `<project>/` |
| Public repo | `<project>/` |
| Private repo | `<project>-backstage/` |
| GitHub public | `org/<project>` |
| GitHub private | `org/<project>-backstage` |

## Daily Workflow

Run CC in `<project>/<project>/` (public repo). CC reads CLAUDE.md + CLAUDE.local.md automatically. Access design docs via `../PROJECT-backstage/...`. No special prompts needed.

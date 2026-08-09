KAGE FRONTEND RECOVERY V43.1

PURPOSE
- Restore website/PWA files that became 0 Bytes in GitHub.
- Does NOT replace pipeline ML/AI .mjs/.py/.yml files.

IMPORTANT
- Upload these files to the ROOT of the Trading repository, preserving assets/ folder.
- Do not put them inside a KAGE-FRONTEND-RECOVERY-V43_1 folder in GitHub.
- Commit once, then wait for GitHub Pages deployment to turn green.

RECOVERY CHANGES
- Restored non-empty V43 audited index.html and frontend assets.
- Restored manifest.webmanifest.
- Restored sw.js and bumped cache to kage-core-v43-recovery-431-shell.
- index.html registers sw.js?v=431 to force service-worker refresh.

VALIDATION
- index.html bytes: 522984
- manifest bytes: 669
- sw.js bytes: 1780
- local frontend refs checked: 13
- missing refs: 0
- JavaScript syntax: PASS

AFTER DEPLOY
1) Open the site in Safari.
2) If an old Home Screen icon still opens blank, remove ONLY that old Home Screen shortcut.
3) Open the restored site in Safari once.
4) Share -> Add to Home Screen again.
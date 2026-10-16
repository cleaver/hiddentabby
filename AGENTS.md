# Repository Guidelines

## Project Structure

This repository is a small, dependency-free Manifest V3 extension. **manifest.json** declares the extension; **popup.html**, **popup.css**, and **popup.js** implement its toolbar popup. **README.md** explains how to load it in Chrome and Brave. Keep extension resources local and at the repository root unless the project grows enough to justify feature directories.

## Local Development

There is no build or install command. Open chrome://extensions in Chrome or brave://extensions in Brave, enable **Developer mode**, and choose **Load unpacked** with this repository as the folder. After editing files, use **Reload** on the extension card and reopen the popup.

## Style and Naming

Use two spaces for HTML, CSS, and JavaScript indentation. Keep JavaScript in separate files, use camelCase for variables and functions, and use kebab-case for CSS classes. Prefer semantic HTML, accessible labels, and textContent for page-derived text. Avoid remote scripts, inline JavaScript, and new dependencies unless a feature requires them.

## Testing

No automated test framework is configured. For UI or API changes, load the extension in both Chrome and Brave and check the affected behavior on a regular webpage. Also check browser-internal pages when changing active-tab handling; those pages may restrict extension access. Request only the permissions needed for the feature.

## Commits and Pull Requests

This fresh repository has no commit history to establish existing conventions. Use short Conventional Commit subjects, such as feat: add tab actions or fix: handle missing page titles. When bumping the version in **manifest.json**, create and push the matching Git tag (for example, `v0.1.3`); the release workflow builds and publishes only when the tag matches the manifest version. Pull requests should describe the user-visible change, list the browsers checked, include a screenshot for popup changes, and explain any manifest permission changes.

# How to publish this starter kit as a PUBLIC GitHub repository

**The starter kit contains only source code and neutral placeholders. It does not create a database, website, or account by itself.**

## Easy way (GitHub Desktop)

1. Download the starter-kit ZIP and **extract** it on your computer.
2. First create a **new empty PUBLIC repository** at https://github.com/new under the intended GitHub account, using the repository name `AIESEC-Marketing-Approval-System-to-be-shared`. Do not initialize it with a README or license at this step.
3. Install GitHub Desktop and sign in to **your own** GitHub account.
4. Choose **File → Add local repository**, select the extracted folder, then choose **Create a repository here** if prompted. Use the repository name `AIESEC-Marketing-Approval-System-to-be-shared`.
5. Commit the files and push them to your **new empty public GitHub repository**. If the repository already exists on GitHub, use **Repository → Repository settings → Remote** or Git command-line instructions below to set its URL. Avoid clicking **Publish repository** to create a second repository with the same name.
6. Copy the new repository URL and share it. Recipients can click **Code → Download ZIP** and set up an independent copy.

Do not upload an entire ZIP as a single repository file if you want visitors to browse/download the source tree. Publish the extracted project files instead.

## Alternative (Git command line)

In the extracted folder, after creating an empty **public** GitHub repository under YOUR GitHub account:

```bash
git init
git add .
git commit -m "Publish generic entity marketing approval starter kit"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/AIESEC-Marketing-Approval-System-to-be-shared.git
git push -u origin main
```

The repository URL in this example is a placeholder, not an existing repository. Never add an existing entity's production repository as a remote.

**Before publishing:** Verify the extracted kit contains no `.env.local`, passwords, real email accounts, live database URL, private brand assets, or stored member/submission data. Choose a software license only if you have the necessary rights to grant it.

## Exact requested title

- Project/display title: **AIESEC - Marketing Approval System to be shared**
- GitHub URL-safe name: **AIESEC-Marketing-Approval-System-to-be-shared**
- Visibility: **Public**
- Owner: only the account/organization selected when creating the new repository. Nothing in this package connects to SLIIT’s original private repository.

**Reuse permission:** Public visibility permits viewing and downloading, but does not grant an open-source license automatically. Choose a suitable license (for example, MIT) only if you are authorized to license the source and associated assets.

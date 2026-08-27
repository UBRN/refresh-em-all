# Manual Developer Dashboard checklist: Refresh Em All v2.4.2

Everything in this file lives in the Chrome Web Store Developer Dashboard or in Google's
publisher records. **None of it can be verified from this repository**, so nothing here is
pre-ticked. Tick an item only after you have looked at the live dashboard yourself.

The repository-verifiable half of the release (package contents, SHA-256, screenshots,
permissions, privacy behaviour) is covered in [`listing.md`](listing.md).

## 1. Publisher account and identity

- [ ] Publisher contact email is present and **verified** in the developer account.
      An unverified contact email blocks publication.
- [ ] Publisher display name is the one you want shown on the listing.
- [ ] Publisher identity / account status shows no restriction, suspension, or pending
      verification step.
- [ ] Two-factor authentication is enabled on the Google account that owns the item.

## 2. Policy standing

- [ ] The item shows **no active policy violations** and no unresolved warnings in the
      dashboard. This is a hard prerequisite for a Featured nomination.
- [ ] No takedown, rejection, or appeal is currently open against this item.

## 3. Distribution

- [ ] Visibility is set to **Public** (not Unlisted or Private), required before the
      extension can be nominated as Featured.
- [ ] Distribution regions match your intent. Leave all regions selected unless you have a
      documented reason to limit them.
- [ ] Category is **Productivity**.

## 4. Localized listing

- [ ] Default language is **English**.
- [ ] English title, summary, and detailed description are entered from `listing.md`
      §"Listing content (English)".
- [ ] **Turkish (Türkçe)** is added as an additional language, and its title, summary, and
      detailed description are entered from `listing.md` §"Listing content (Turkish)".
      The Store keeps localized listing text separately from the extension's own
      `_locales/` catalogs. Shipping `_locales/tr` does **not** populate the listing.
- [ ] Turkish screenshots are uploaded under the Turkish language tab
      (`docs/chrome-web-store/assets/screenshots/tr/`), and English screenshots under the
      English tab. Confirm each set renders under the right language.
- [ ] The 440×280 promotional image is uploaded.

## 5. Privacy and data use

- [ ] Single-purpose description matches `listing.md` exactly.
- [ ] A justification is entered for **each** declared permission (`tabs`, `scripting`,
      `storage`, and the optional `<all_urls>` host permission), copied from `listing.md`
      §"Reviewer-facing permission text", and each one matches the uploaded manifest.
- [ ] **No, I am not using remote code** is selected.
- [ ] Data-use declarations are exactly **Web history** and **Website content**; no other
      category is selected. Web history covers locally handled open-tab details, and Website
      content covers locally handled media properties and Resource Timing size fields.
- [ ] All four substantive Limited Use elements are certified: allowed use, allowed
      transfer, prohibited advertising, and prohibited human access.
- [ ] Privacy policy URL is entered **and loads publicly**:
      `https://github.com/UBRN/refresh-em-all/blob/main/PRIVACY.md`

## 6. Support surfaces

- [ ] Homepage URL is set: `https://github.com/UBRN/refresh-em-all`
- [ ] Support URL is set and reachable: `https://github.com/UBRN/refresh-em-all/issues`
- [ ] **A real, monitored support email is entered.** The repository does not contain one and
      this release does not invent one. Featured nomination requires support in English, so
      whichever address you use must be one somebody actually reads.

## 7. Package upload

- [ ] The uploaded ZIP is the exact artifact recorded in `listing.md`: confirm the filename,
      byte size, and SHA-256 before uploading. Do not upload a rebuilt or re-zipped copy
      without re-recording its hash.
- [ ] After upload, the dashboard shows version **2.4.2**.
- [ ] Reviewer notes are filled in from `listing.md` §"Submission checklist".

## 8. After the public version is live

- [ ] The v2.4.2 update has finished review and is actually serving to users.
- [ ] Give the public version time to stabilise (no crash reports, no policy warnings, no
      spike in uninstalls) **before** nominating it for Featured.
- [ ] Submit the Featured nomination manually through **One Stop Support** in the Developer
      Dashboard. There is no automatic nomination and no API for it.
- [ ] Re-read the nomination form's prerequisites at the moment you submit: Google edits
      them without notice. The set recorded in `listing.md` is what applied when this
      release was prepared, and the live form is authoritative over it.
- [ ] Check the nomination frequency limit before submitting (reported as one
      nomination per six months). Do not spend the window on a version you are not
      confident in.

## 9. Things you wait for rather than do

- [ ] **Enhanced Safe Browsing trust**: this accrues from publisher history, not from
      anything in the package. A new publisher typically waits **several months** of
      compliant presence in the Store. Nothing in this release accelerates it, and removing
      permissions does not buy it. See `listing.md` §"Trust, badges, and what this release
      can and cannot change".
- [ ] **Established Publisher badge**: depends on verified publisher identity plus a
      compliance track record, and appears to also require a **verified related
      website**. Verify site ownership early; it is the slowest part to arrange.
- [ ] **Featured badge**: manually reviewed by the Chrome Web Store team. Meeting every
      prerequisite makes an item *eligible*, not selected. It is not guaranteed.

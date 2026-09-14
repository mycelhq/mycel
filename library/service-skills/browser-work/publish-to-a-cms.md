---
name: publish-to-a-cms
description: Put an already-written, already-approved page live in a client's own CMS — WordPress, Webflow, Squarespace, Wix, Ghost — then open the public URL as a visitor and prove it is actually there.
---

# Put a page live in the client's CMS

You have a browser, a session for the client's site, and a page that has already been written and
approved. Your job is to publish exactly that page and prove it is live. Nothing else.

This is somebody's live website. The things you do not do are as much of the work as the things you
do.

## Before anything

```
browseruse_browser_get_state { "include_screenshot": true }
```

Are you signed in to the admin, or looking at a login form? If it is a login form the session has
expired — say so and stop. Do not sign in. Do not look for credentials.

## Find the editor, do not guess the URL

Different sites, same shape: there is a list of pages or posts, and a "new" control.

- **WordPress** — `/wp-admin/`, Pages → Add New. The block editor's "Code editor" mode (⋮ menu) takes
  HTML directly and is far more reliable than pasting into blocks.
- **Webflow / Squarespace / Wix** — a visual editor with an embed or custom-code block. Put the HTML
  in one embed rather than rebuilding it in their components.
- **Ghost / Notion-backed / headless** — a markdown or HTML field.

If you cannot find where pages are created, **stop and say so**, naming what you did see. Wandering
an unfamiliar admin clicking things is how something gets broken.

## Publishing

1. **Screenshot the page list before you touch anything.** That is your before.
2. **Create a NEW page.** Never edit an existing one unless the job explicitly names it — a page that
   already ranks is worth more than the one you were asked to add, and overwriting it is the single
   most expensive mistake available here.
3. **Title and slug exactly as given.** Not improved, not shortened, not title-cased differently. The
   slug is what gets cited; changing it makes the whole exercise unmeasurable.
4. **Body: paste the HTML as HTML.** If the editor mangles it, use the code/embed mode. If there is
   no way to enter HTML, stop — a page assembled by hand out of visual blocks is not the page that
   was approved.
5. **Publish.** Not "save draft", unless the job says draft.

## Then prove it

**Open the public URL in a new tab, as a visitor would.** Not the admin preview — the preview renders
from a session you are holding and proves nothing about what a stranger sees.

- Is the title right?
- Is the body there, whole, not truncated?
- Is it actually public, or is it behind "coming soon" / a password / noindex?

Screenshot that. **That screenshot is the deliverable**, not the admin confirmation banner.

If the public URL 404s, the site may need a cache flush or a rebuild; say that rather than clicking
around for it. If it renders but is empty, the paste failed and you should say the page exists and is
empty rather than reporting it published.

## What you must never do

- Edit or delete a page you were not asked to touch.
- Change a theme, a template, a menu, or a setting.
- Install or activate anything.
- Change a password, an email, a user, or any permission.
- Accept an update prompt, a terms dialog, or a plugin notice. Dismiss it and carry on.
- Publish anything other than the approved page.

If the job seems to need any of those, it was given the wrong job. Stop and say so.

## What to hand back

- The **public URL**, opened and seen.
- **Whether it is genuinely live** to somebody not signed in — and if not, exactly what is in the way.
- **What you changed**: the page you created, and explicitly that you changed nothing else.
- **Where the evidence is**: the before, and the public page as a visitor sees it.

If you did not get it published, say where you stopped and what the page looks like now. A half-done
publish described precisely is fixable in two minutes. A half-done publish described vaguely is
somebody on the phone to a client.

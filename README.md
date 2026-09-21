# Read Aloud

Paste text or Markdown and have it read aloud in your browser.

- Play, Pause / Resume and Restart buttons
- Double-click (or double-tap) any word to start reading from there
- Pauses at commas, full stops, line breaks and paragraph breaks
- Understands Markdown: headings, bold, italic, strike-through, nested lists,
  task lists, tables, block quotes, links, images (alt text) and code blocks
- Markdown symbols are never read aloud; code blocks are shown but skipped
- Zoom in / zoom out buttons (top-right of the text area)
- Voice, speed, tone and pause-length controls

It is a plain static site (HTML + CSS + JavaScript). There is no build step,
no dependencies, and no API key. Speech uses the browser's built-in
Web Speech API, which needs HTTPS (Vercel provides it).

## Files

    index.html   page structure
    style.css    styles
    script.js    app logic
    vercel.json  Vercel settings

## Run locally

Open `index.html` in a browser, or serve the folder:

    npx serve .

## Deploy to Vercel

Option 1: Vercel CLI

    npm i -g vercel
    cd read-aloud
    vercel          # follow the prompts
    vercel --prod   # publish to production

When asked, choose "Other" as the framework, leave the build command empty,
and keep the output directory as `.` (the project root).

Option 2: GitHub

1. Put this folder in a new GitHub repository.
2. On vercel.com choose "Add New... > Project" and import the repository.
3. Framework Preset: "Other". Leave Build Command and Output Directory empty.
4. Click Deploy.

## Tips

For the most natural voice, open the site in Microsoft Edge and pick a voice
marked "Natural", or in Chrome pick a "Google" voice. On iPhone or Mac, add an
Enhanced voice under Settings > Accessibility > Spoken Content > Voices.

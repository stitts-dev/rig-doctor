// Points the download buttons at the newest published desktop release and puts the visitor's
// system first. Without JavaScript, or if GitHub's API doesn't answer, the buttons open the
// releases page.
const REPO = "stitts-dev/rig-doctor";
const win = document.getElementById("dl-win");
const mac = document.getElementById("dl-mac");
const info = document.getElementById("release");

const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
if (/mac/i.test(platform)) {
  mac.classList.add("primary");
  win.classList.remove("primary");
  mac.parentNode.prepend(mac);
}

function show(parts) {
  info.replaceChildren(...parts);
  info.hidden = false;
}

fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub API ${r.status}`))))
  .then((releases) => {
    const rel = releases.find((r) => !r.draft && !r.prerelease && /^desktop-v\d/.test(r.tag_name));
    if (!rel) {
      for (const b of [win, mac]) {
        b.removeAttribute("href");
        b.setAttribute("aria-disabled", "true");
      }
      show(["The first public build isn't published yet."]);
      return;
    }
    const asset = (re) => rel.assets.find((a) => re.test(a.name));
    const exe = asset(/-setup\.exe$/i) || asset(/\.exe$/i);
    const dmg = asset(/\.dmg$/i);
    if (exe) win.href = exe.browser_download_url;
    if (dmg) mac.href = dmg.browser_download_url;
    const version = rel.tag_name.replace(/^desktop-v/, "");
    const date = new Date(rel.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const notes = document.createElement("a");
    notes.href = rel.html_url;
    notes.textContent = "Release notes";
    show([`Version ${version}, released ${date}. `, notes]);
  })
  .catch(() => {});

#!/usr/bin/env bash
# electron.sh <RUN> dev|packaged|dev-base
#
# Starts the Electron desktop app on Linux under xvfb-run, with its own
# XDG_CONFIG_HOME (your ~/.config/LearnHarness is never used) and a CDP port,
# and writes <RUN>/electron-<mode>/instance.env for web-teach.mjs to attach to.
#   dev:      the dev shell (LH_DEV_URL) pointed at the head instance from
#             start.sh, so it shares that server, data and fake model.
#   packaged: electron-builder --linux dir (unpacked, unsigned, no publish),
#             then the real desktop binary, which spawns its own bundled
#             server with a per-launch API secret. Fake model: the head
#             instance's, seeded from inside the window.
#   dev-base: the base commit's own dev shell pointed at the base instance:
#             the answer key for desktop-only output (the bridge, native
#             window chrome), which browser parity can't see.
# Needs the head instance running (start.sh <RUN> head), or the base one for
# dev-base. Returns once the window shows the app. stop.sh <RUN> stops it
# (xvfb-run leads its group).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RUN=$(canon_run "${1:?usage: electron.sh <RUN> dev|packaged|dev-base}")
MODE=${2:?usage: electron.sh <RUN> dev|packaged|dev-base}
SIDE_INST=$RUN/head/instance.env
[ "$MODE" = dev-base ] && SIDE_INST=$RUN/base/instance.env
[ -f "$SIDE_INST" ] || die "start that instance first: start.sh $RUN $([ "$MODE" = dev-base ] && echo base || echo head)"
# shellcheck disable=SC1090
. "$SIDE_INST"
ED=$RUN/electron-$MODE
[ ! -f "$ED/instance.env" ] || die "$ED already running; stop.sh $RUN first"
mkdir -p "$ED/config"
command -v xvfb-run >/dev/null || die "BLOCKED: xvfb-run is not installed"
SANDBOX=()
[ "$ELECTRON_NO_SANDBOX" = 1 ] && SANDBOX=(--no-sandbox)
CDP=$(free_port)

# Electron downloads its binary on first use, into the tree's node_modules.
# Head and base trees are shared by every run and worktree, so two cold runs
# would download into the same folder at once: one at a time, under a lock.
ensure_electron() { # <tree>
	local tree=$1
	[ -x "$tree/node_modules/electron/dist/electron" ] && return 0
	(
		flock 9
		[ -x "$tree/node_modules/electron/dist/electron" ] || (cd "$tree" && node node_modules/electron/install.js)
	) 9>"$tree/node_modules/electron/.prove-install.lock" >>"$ED/electron.log" 2>&1
}

case "$MODE" in
	dev)
		BIN=$REPO/node_modules/.bin/electron
		[ -x "$BIN" ] || die "no electron in node_modules; run npm ci"
		# Electron downloads its binary on first use.
		ensure_electron "$REPO"
		ARGS=("$REPO" "${SANDBOX[@]}" "--remote-debugging-port=$CDP")
		ENVS=(LH_DEV_URL="$APP_URL")
		WANT_URL=$APP_URL
		SEED=0
		E_DATA=$DATA_DIR
		# The dev window loads the head server, which needs a login: web-teach
		# gives the window the head instance's session cookie.
		LOGIN="APP_PORT=$APP_PORT
APP_TOKEN=$APP_TOKEN"
		;;
	dev-base)
		# BUILD_DIR comes from the base instance.env: the base commit's tree.
		BIN=$BUILD_DIR/node_modules/.bin/electron
		[ -x "$BIN" ] || die "no electron in the base build's node_modules ($BUILD_DIR)"
		ensure_electron "$BUILD_DIR"
		ARGS=("$BUILD_DIR" "${SANDBOX[@]}" "--remote-debugging-port=$CDP")
		ENVS=(LH_DEV_URL="$APP_URL")
		WANT_URL=$APP_URL
		SEED=0
		E_DATA=$DATA_DIR
		LOGIN="APP_PORT=$APP_PORT
APP_TOKEN=$APP_TOKEN"
		;;
	packaged)
		t0=$SECONDS
		ensure_electron "$REPO"
		(cd "$REPO" && npx electron-builder --linux dir --publish never) >"$ED/package.log" 2>&1 || { tail -30 "$ED/package.log" >&2; die "electron-builder --linux dir failed"; }
		say "[electron] packaged in $((SECONDS - t0))s"
		BIN=$REPO/dist/linux-unpacked/learnharness-nightly
		[ -x "$BIN" ] || die "no executable at $BIN"
		ARGS=("${SANDBOX[@]}" "--remote-debugging-port=$CDP")
		ENVS=()
		WANT_URL=http://127.0.0.1
		SEED=1
		E_DATA="$ED/config/LearnHarness Nightly/data"
		LOGIN=""
		;;
	*) die "mode must be dev, packaged or dev-base" ;;
esac

# env -i: no ambient keys or settings reach Electron or the server it spawns
# (packaged mode passes its environment on), and a throwaway HOME.
mkdir -p "$ED/home"
# Opt-in first-frame timings pass through the clean environment.
[ "${LH_DEBUG_FIRST_FRAME:-}" = 1 ] && ENVS+=(LH_DEBUG_FIRST_FRAME=1)
setsid nohup env -i PATH="$PATH" HOME="$ED/home" LANG=C.UTF-8 XDG_CONFIG_HOME="$ED/config" LH_IGNORE_ENV_KEYS=1 "${ENVS[@]}" \
	xvfb-run -a --server-args="-screen 0 1280x900x24" "$BIN" "${ARGS[@]}" </dev/null >>"$ED/electron.log" 2>&1 &
echo $! >"$ED/electron.pid"

if [ "$MODE" = packaged ]; then
	# An isolated profile reaches the app-owned first-run window before
	# starting the bundled server. Drive the same button as a local user.
	wait_for "$BOOT_TIMEOUT_S" curl -sf "http://127.0.0.1:$CDP/json/version" >/dev/null || die "no Electron CDP on $CDP"
	(cd "$REPO" && node - "$CDP" "$BOOT_TIMEOUT_S" <<'JS'
const puppeteer = require("puppeteer-core");
(async () => {
	const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.argv[2]}`, defaultViewport: null });
	const timeout = Number(process.argv[3]) * 1000;
	try {
		// The picker's URL carries a theme query (server-list.html?mode=dark): match the path.
		const onPicker = (item) => { try { return new URL(item.url()).pathname.endsWith("/server-list.html"); } catch { return false; } };
		const target = await browser.waitForTarget((item) => item.type() === "page" && onPicker(item), { timeout });
		const page = await target.page();
		const choice = await page.waitForSelector("#run-local", { visible: true, timeout });
		await choice.click();
	} finally { await browser.disconnect(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
JS
	) || die "could not select local first-run setup"
fi

page_url() { curl -sf "http://127.0.0.1:$CDP/json/list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.type==="page"&&/^http:\/\/127\.0\.0\.1:\d+\//.test(x.url));if(!p)process.exit(1);console.log(new URL(p.url).origin)})'; }
wait_for "$BOOT_TIMEOUT_S" page_url || { tail -30 "$ED/electron.log" >&2; die "no Electron window on CDP $CDP within ${BOOT_TIMEOUT_S}s"; }
URL=$(page_url)
case "$URL" in "$WANT_URL"*) ;; *) die "Electron window shows $URL, expected $WANT_URL" ;; esac

cat >"$ED/instance.env" <<EOF
SIDE=electron-$MODE
APP_URL=$URL
CDP_URL=http://127.0.0.1:$CDP
SEED_IN_PAGE=$SEED
FAKE_URL=$FAKE_URL
FAKE_CONTROL=$FAKE_CONTROL
BUILD_STAMP="$BUILD_STAMP"
DATA_DIR="$E_DATA"
FIXTURE=$FIXTURE
MODEL_LOG=$MODEL_LOG
$LOGIN
EOF
echo "$ED/instance.env"

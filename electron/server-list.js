"use strict";

const $ = (id) => document.getElementById(id);
const api = window.servers;
let state;
let adding = false;

function showPair(origin = "") {
	adding = true;
	$("pair-title").textContent = origin ? "Pair again" : "Connect to my server";
	$("address").value = origin;
	$("code").value = "";
	$("filled").hidden = true;
	$("form-error").textContent = "";
	render();
	$(origin ? "code" : "address").focus();
}

function render() {
	const { servers, active, defaultServer, damaged, busy, removing, problem, notice, signingIn } = state;
	// Also with This computer open once every saved server and the default are removed:
	// what is picked on the setup screen then becomes the default.
	const firstRun = !defaultServer && !problem && servers.length === 0 && !notice;
	$("welcome").hidden = !firstRun || adding;
	$("list").hidden = (firstRun || adding) && !problem;
	$("add-server").hidden = !adding || !!problem;
	$("notice").textContent = removing ? "Removing…" : busy ? "Connecting…" : signingIn ? "Finish sign-in in your browser." : notice;
	$("recovery").hidden = !problem;
	if (problem) {
		$("problem").textContent = problem.message;
		const canPairAgain = problem.kind === "pair" && problem.server !== "local";
		$("recover").hidden = problem.kind === "mismatch";
		$("recover").textContent = canPairAgain ? "Pair again" : "Retry";
		$("recover").onclick = () => {
			if (canPairAgain) {
				state = { ...state, problem: null };
				showPair(problem.server);
			} else if (problem.server === "local" || servers.includes(problem.server)) {
				void api.connect(problem.server);
			} else {
				state = { ...state, problem: null };
				showPair(problem.server);
			}
		};
	}
	$("servers").replaceChildren(...["local", ...servers].map((server) => {
		const item = document.createElement("li");
		const label = document.createElement("span");
		label.textContent = server === "local" ? "This computer" : server;
		const tags = [server === active && "Active", server === defaultServer && "Default"].filter(Boolean);
		if (tags.length) {
			const caption = document.createElement("small");
			caption.textContent = tags.join(" · ");
			label.append(caption);
		}
		item.append(label);
		if (server !== active || (!damaged && server !== defaultServer)) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = server === active ? "Set as default" : "Connect";
			button.onclick = () => void (server === active ? api.setDefault(server) : api.connect(server));
			item.append(button);
		}
		if (server !== "local" && !damaged) {
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Remove…";
			remove.setAttribute("aria-label", `Remove ${server} from this device`);
			remove.onclick = async () => {
				await api.remove(server);
				// Its row is gone: keep the focus in the list for the keyboard.
				if (!document.activeElement || document.activeElement === document.body) {
					[...document.querySelectorAll("main button")].find((button) => !button.disabled && !button.closest("[hidden]"))?.focus();
				}
			};
			item.append(remove);
		}
		return item;
	}));
	$("add").hidden = damaged;
	$("reset").hidden = !damaged;
	$("sign-in").hidden = !active || active === "local";
	$("pair-submit").textContent = busy && !removing ? "Connecting…" : "Connect";
	document.querySelectorAll("button, input").forEach((input) => { input.disabled = busy; });
	$("sign-in").disabled = busy || signingIn;
}
api.onChange((next) => { state = next; render(); });
void api.state().then((next) => { state = next; render(); });

$("run-local").onclick = () => void api.connect("local");
$("connect-remote").onclick = () => showPair();
$("reset").onclick = () => void api.reset();
$("add").onclick = () => { state = { ...state, problem: null }; showPair(); };
$("back").onclick = () => { adding = false; render(); };
$("sign-in").onclick = () => void api.signIn();
// A pasted pairing link becomes the address and fills in the code.
$("address").addEventListener("input", async (event) => {
	$("filled").hidden = true;
	const text = event.target.value;
	const parsed = await api.parseLink(text);
	if (text !== $("address").value || !parsed) return;
	$("address").value = parsed.origin;
	$("code").value = parsed.code;
	$("filled").hidden = false;
	$("form-error").textContent = "";
});
$("code").addEventListener("input", () => { $("filled").hidden = true; });
$("pair").onsubmit = async (event) => {
	event.preventDefault();
	$("form-error").textContent = await api.pair($("address").value, $("code").value) ?? "";
};

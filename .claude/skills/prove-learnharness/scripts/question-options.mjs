/**
 * Reading and picking a question card's options in the browser. Since
 * c3ff55ff ("label single-select question options", reached main through the
 * upstream 0.7.0 merge, #322) each single-select option carries a letter
 * badge (`[data-option-letter]`, components/question-dock.tsx), so an
 * option's textContent is "ABlue". The label under test is the option's text
 * without its badge; the letters are read on their own.
 */
const OPTIONS = '[data-testid="question-dock"] [role="radio"]';

/** [{ label, letter }] for each option, in on-screen order. */
export function readOptions(page) {
	return page.$$eval(OPTIONS, (els) => els.map((e) => {
		const copy = e.cloneNode(true);
		const badges = [...copy.querySelectorAll("[data-option-letter]")];
		const letter = badges[0] ? badges[0].textContent.trim() : null;
		for (const badge of badges) badge.replaceWith("");
		return { label: copy.textContent.trim(), letter };
	}));
}

/** Click the option whose label (badge left out) is `label`; false when none is. */
export async function clickOption(page, label) {
	const options = await readOptions(page);
	const at = options.findIndex((o) => o.label === label);
	if (at < 0) return false;
	await (await page.$$(OPTIONS))[at].click();
	return true;
}

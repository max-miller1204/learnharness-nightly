"use client";

/**
 * Release note sections, shared by the sidebar update pill's popover and
 * the What's new popup (docs/specs/t3-style-updates.md, section 5).
 *
 * Adapted from T3 Code's SidebarUpdateReleaseNotes
 * (apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx).
 * MIT License, Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the
 * following conditions: The above copyright notice and this permission
 * notice shall be included in all copies or substantial portions of the
 * Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */

import { ExternalLinkIcon } from "lucide-react";
import type { ReleaseNoteGroup } from "@/src/core";

export const releaseUrl = (homepage: string, version: string) =>
	homepage ? `${homepage}/releases/tag/v${encodeURIComponent(version)}` : null;
export const releaseHistoryUrl = (homepage: string) => (homepage ? `${homepage}/releases` : null);

/** The newest group reads "What's changed"; skipped versions read "Changes in X" (T3's headings). */
export const groupHeading = (index: number, version: string) => (index === 0 ? "What's changed" : `Changes in ${version}`);

function keyItems(items: readonly string[]) {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const n = seen.get(item) ?? 0;
		seen.set(item, n + 1);
		return { item, key: `${item}#${n}` };
	});
}

function ReleaseLink({ href, children }: { href: string; children: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
		>
			{children}
			<ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
		</a>
	);
}

export function ReleaseNoteSections({ groups, omittedReleaseCount, homepage }: {
	groups: readonly ReleaseNoteGroup[];
	omittedReleaseCount: number;
	homepage: string;
}) {
	const history = releaseHistoryUrl(homepage);
	return (
		<div data-testid="release-notes-sections">
			{groups.map((group, index) => {
				const link = releaseUrl(homepage, group.version);
				return (
					<section className={index > 0 ? "mt-4" : undefined} key={group.version} data-testid="release-notes-group">
						<h3 className="mb-2 text-xs leading-4 font-semibold text-foreground">{groupHeading(index, group.version)}</h3>
						{group.items.length > 0 && (
							<ul className="space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
								{keyItems(group.items).map(({ item, key }) => {
									const highlight = /^\*\*([^*]+)\*\* (.+)$/.exec(item);
									return (
										<li className="list-disc break-words" key={key}>
											{highlight ? <><strong>{highlight[1]}</strong> {highlight[2]}</> : item}
										</li>
									);
								})}
							</ul>
						)}
						{link && <ReleaseLink href={link}>Read more</ReleaseLink>}
					</section>
				);
			})}
			{omittedReleaseCount > 0 && history && (
				<div className="mt-3">
					<ReleaseLink href={history}>{`${omittedReleaseCount} older ${omittedReleaseCount === 1 ? "release" : "releases"} on GitHub`}</ReleaseLink>
				</div>
			)}
		</div>
	);
}

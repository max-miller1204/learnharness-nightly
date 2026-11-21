"use client";

/**
 * Release notes as T3 Code shows them, shared by the sidebar update
 * control's popover (UpdateReleaseNotes) and the What's new popup
 * (ReleaseNoteSections). docs/specs/t3-style-updates.md, revision PR 2.
 *
 * Ported from T3 Code's SidebarUpdateReleaseNotes
 * (apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx at
 * df09ced7, :24-34 formatReleaseAge, :60-178 the popover) and the
 * relative labels of apps/web/src/timestampFormat.ts:325-333: the "Update
 * ready to download" header with its "X · 3h ago" line, "What's changed"
 * and "Changes in X", a generated summary's version and age heading, its
 * intro, items and footer, and the link labels "View release on GitHub",
 * "N more changes on GitHub" (or the summary's stats) and "N older releases
 * on GitHub". Changes: plain strings for gt-react, plain links that open in
 * a new tab (the desktop app opens them in the system browser).
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
import { totalReleaseItems, withoutSummaryEcho, type ReleaseNoteGroup } from "@/src/core";

export const releaseUrl = (homepage: string, version: string) =>
	homepage ? `${homepage}/releases/tag/v${encodeURIComponent(version)}` : null;
export const releaseHistoryUrl = (homepage: string) => (homepage ? `${homepage}/releases` : null);

/** The newest group reads "What's changed"; skipped versions read "Changes in X" (T3's headings). */
export const groupHeading = (index: number, version: string) => (index === 0 ? "What's changed" : `Changes in ${version}`);

const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

/** T3's formatReleaseAge: feed times read "3h ago"; build days from a nightly's version read "today" or "2d ago".
 *  Empty when the time can't be read. */
export function formatReleaseAge(releasedAt: string, now: number = Date.now()): string {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releasedAt);
	if (day) {
		const today = new Date(now);
		const days = Math.round((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) / 86_400_000);
		return days <= 0 ? "today" : `${days}d ago`;
	}
	const time = Date.parse(releasedAt);
	if (!Number.isFinite(time)) return "";
	const seconds = Math.floor(Math.max(0, now - time) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** "X · 3h ago", or the version alone when its time is unknown. */
export function versionWithAge(version: string, releasedAt: string | undefined, now: number = Date.now()): string {
	const age = releasedAt ? formatReleaseAge(releasedAt, now) : "";
	return age ? `${version} · ${age}` : version;
}

/** The release link's label: a summary's stats, else "View release on GitHub" or "N more changes on GitHub". */
export function releaseLinkLabel(group: ReleaseNoteGroup): string {
	if (group.stats) return group.stats;
	const omitted = Math.max(0, totalReleaseItems(group) - withoutSummaryEcho(group.items, group).length);
	return omitted === 0 ? "View release on GitHub" : `${plural(omitted, "more change", "more changes")} on GitHub`;
}

export const olderReleasesLabel = (count: number) => `${plural(count, "older release", "older releases")} on GitHub`;

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
			className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
		>
			{children}
			<ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
		</a>
	);
}

/** One section per version (T3's SidebarUpdateReleaseNotes body). `offeredVersion` is the update's
 *  own version: a generated summary of it needs no heading, the header names it. */
export function ReleaseNoteSections({ groups, omittedReleaseCount, homepage, offeredVersion, now }: {
	groups: readonly ReleaseNoteGroup[];
	omittedReleaseCount: number;
	homepage: string;
	offeredVersion?: string | null;
	now?: number;
}) {
	const history = releaseHistoryUrl(homepage);
	return (
		<div data-testid="release-notes-sections">
			{groups.map((group, index) => {
				const link = releaseUrl(homepage, group.version);
				const generated = group.stats !== undefined || group.intro !== undefined;
				// The notes keep the old-client copy of the intro or footer; it shows once, as itself.
				const items = withoutSummaryEcho(group.items, group);
				return (
					<section className={index > 0 ? "mt-4" : undefined} key={group.version} data-testid="release-notes-group">
						{generated ? (
							group.version !== offeredVersion && (
								<h3 className="mb-1 text-xs leading-4 font-medium text-muted-foreground">{versionWithAge(group.version, group.releasedAt, now)}</h3>
							)
						) : (
							<h3 className="mb-2 text-xs leading-4 font-semibold text-foreground">{groupHeading(index, group.version)}</h3>
						)}
						{group.intro ? (
							<p className="break-words text-xs leading-5 text-popover-foreground" data-testid="release-notes-intro">{group.intro}</p>
						) : items.length > 0 ? (
							<ul className="space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
								{keyItems(items).map(({ item, key }) => {
									const highlight = /^\*\*([^*]+)\*\* (.+)$/.exec(item);
									return (
										<li className="list-disc break-words" key={key}>
											{highlight ? <><strong>{highlight[1]}</strong> {highlight[2]}</> : item}
										</li>
									);
								})}
							</ul>
						) : null}
						{group.footer && <p className="mt-2 text-xs leading-5 font-semibold" data-testid="release-notes-footer">{group.footer}</p>}
						{link && <ReleaseLink href={link}>{releaseLinkLabel(group)}</ReleaseLink>}
					</section>
				);
			})}
			{omittedReleaseCount > 0 && history && (
				<div className="mt-3">
					<ReleaseLink href={history}>{olderReleasesLabel(omittedReleaseCount)}</ReleaseLink>
				</div>
			)}
		</div>
	);
}

/** The update control's popover content (T3's SidebarUpdateReleaseNotes): for an update ready to
 *  download, "Update ready to download" over "X · 3h ago"; otherwise the control's hover text. */
export function UpdateReleaseNotes({ groups, omittedReleaseCount, homepage, offeredVersion, available, title, now }: {
	groups: readonly ReleaseNoteGroup[];
	omittedReleaseCount: number;
	homepage: string;
	offeredVersion: string | null;
	available: boolean;
	title: string;
	now?: number;
}) {
	const releasedAt = groups.find((group) => group.version === offeredVersion)?.releasedAt;
	return (
		<>
			<div className="shrink-0 px-1" data-testid="update-notes-header">
				{available ? (
					<div>
						<div className="whitespace-nowrap text-sm leading-5 font-medium">Update ready to download</div>
						{offeredVersion && <div className="mt-0.5 text-xs leading-4 text-muted-foreground" data-testid="update-notes-age">{versionWithAge(offeredVersion, releasedAt, now)}</div>}
					</div>
				) : (
					<div className="text-sm leading-5 font-medium">{title}</div>
				)}
			</div>
			<div className="min-h-0 overflow-y-auto px-1 pt-3 pb-1">
				<ReleaseNoteSections groups={groups} omittedReleaseCount={omittedReleaseCount} homepage={homepage} offeredVersion={offeredVersion} now={now} />
			</div>
		</>
	);
}

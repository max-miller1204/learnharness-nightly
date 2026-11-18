import { PairScreen } from "@/components/pair-screen";

export const dynamic = "force-dynamic";

/** The pairing screen. proxy.ts also rewrites every signed-out page request
 * here, so it must never read app data. docs/specs/login-pairing.md */
export default function PairPage() {
	return <PairScreen />;
}

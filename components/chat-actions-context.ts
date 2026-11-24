"use client";

import { createContext } from "react";

export interface ChatActions {
	chatId: string;
	syncFromServer: () => Promise<void>;
	sendText: (text: string) => void;
	openSetup: () => void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

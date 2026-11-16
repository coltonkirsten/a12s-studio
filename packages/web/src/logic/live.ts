import type { LiveText, StudioState } from "@a12s-studio/contract/state";

/** The server sends a Turn's last 4000 characters; streamed text keeps to the same window. */
const WINDOW = 4000;

export function appendLive(state: StudioState, live: LiveText): StudioState {
  return {
    ...state,
    teams: state.teams.map((team) => ({
      ...team,
      agents: team.agents.map((agent) =>
        agent.id === live.agent && agent.turn?.id === live.turn
          ? { ...agent, turn: { ...agent.turn, text: (agent.turn.text + live.text).slice(-WINDOW) } }
          : agent,
      ),
    })),
  };
}

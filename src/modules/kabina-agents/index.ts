// «Агенты» of the «Кабина» (DarkAgents.dc.html): the live agent trees of every project.
export { default as AgentsScreen } from '@/modules/kabina-agents/AgentsScreen';
// The live agent tree (GET /api/agents/live + ws `agents.*`): the chat's subagent cards and turn line.
export { useAgentsLive } from '@/modules/kabina-agents/hooks/useAgentsLive';

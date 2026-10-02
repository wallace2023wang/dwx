import { create } from 'zustand'

interface ProjectState {
  currentProjectId: string | null
  currentRuleset: string
  setCurrentProject: (projectId: string) => void
  setCurrentRuleset: (ruleset: string) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProjectId: null,
  currentRuleset: 'main',
  setCurrentProject: (currentProjectId) => set({ currentProjectId }),
  setCurrentRuleset: (currentRuleset) => set({ currentRuleset }),
}))

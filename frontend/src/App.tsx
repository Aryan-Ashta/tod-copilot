import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppProvider } from './state/AppContext'
import PromptScreen from './screens/PromptScreen'
import PlanScreen from './screens/PlanScreen'
import MeetingScreen from './screens/MeetingScreen'
import IsoTestScreen from './screens/IsoTestScreen'

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route path="/" element={<PromptScreen />} />
          <Route path="/plan/:planId" element={<PlanScreen />} />
          <Route path="/meeting/:planId" element={<MeetingScreen />} />
          <Route path="/iso-test" element={<IsoTestScreen />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  )
}

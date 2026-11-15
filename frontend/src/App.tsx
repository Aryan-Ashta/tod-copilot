import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppProvider } from './state/AppContext'
import PromptScreen from './screens/PromptScreen'
import PlanScreen from './screens/PlanScreen'
import EditScreen from './screens/EditScreen'
import IsoTestScreen from './screens/IsoTestScreen'

/** Old meeting-mode links: /meeting/:planId → /edit/:planId. */
function MeetingRedirect() {
  const { planId = '' } = useParams()
  return <Navigate to={`/edit/${planId}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route path="/" element={<PromptScreen />} />
          <Route path="/plan/:planId" element={<PlanScreen />} />
          <Route path="/edit/:planId" element={<EditScreen />} />
          <Route path="/meeting/:planId" element={<MeetingRedirect />} />
          <Route path="/iso-test" element={<IsoTestScreen />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  )
}

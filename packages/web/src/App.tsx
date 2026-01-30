import { Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Workspace } from './pages/Workspace';
import { Task } from './pages/Task';

export default function App() {
  return (
    <div className="min-h-screen">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/workspace/:id" element={<Workspace />} />
        <Route path="/task/:id" element={<Task />} />
      </Routes>
    </div>
  );
}

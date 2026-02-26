import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SeriesBrowser from './pages/SeriesBrowser';
import SeriesDetail from './pages/SeriesDetail';
import BookBrowser from './pages/BookBrowser';
import DataQuality from './pages/DataQuality';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/series" element={<SeriesBrowser />} />
        <Route path="/series/:id" element={<SeriesDetail />} />
        <Route path="/books" element={<BookBrowser />} />
        <Route path="/quality" element={<DataQuality />} />
      </Route>
    </Routes>
  );
}

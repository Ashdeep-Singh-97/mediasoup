import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import TeacherPage from './TeacherPage';
import StudentPage from './StudentPage';

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/teacher" element={<TeacherPage />} />
        <Route path="/student" element={<StudentPage />} />
        <Route path="/" element={<h1>Welcome! Go to <a href="/teacher">Teacher</a> or <a href="/student">Student</a></h1>} />
      </Routes>
    </Router>
  );
};

export default App;
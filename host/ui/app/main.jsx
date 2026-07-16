import { createRoot } from 'react-dom/client'
import App from './App'
import { injectFonts, loadThemePref, resolveTheme } from './theme'
import './styles.css'

// Theme before the first paint so there is no flash. The generated document also
// carries a fallback dark background in its <head> for the same reason.
injectFonts()
document.documentElement.setAttribute('data-theme', resolveTheme(loadThemePref()))

createRoot(document.getElementById('root')).render(<App />)

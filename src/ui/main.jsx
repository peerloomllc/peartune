import { createRoot } from 'react-dom/client'
import App from './App'
import { injectGlobalStyles, loadThemePref, resolveTheme } from './theme'
import './styles.css'

// Theme BEFORE the first paint. The shell already stamped data-theme on <html>
// from the preference it read out of the worklet, so this is belt and braces for
// the browser preview (and for a boot where the shell could not read it). Not
// applyThemePref: that would persist and report, which is not this file's job.
injectGlobalStyles()
document.documentElement.setAttribute('data-theme', resolveTheme(loadThemePref()))

createRoot(document.getElementById('root')).render(<App />)

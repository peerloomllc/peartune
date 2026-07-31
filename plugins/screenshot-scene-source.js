// Store-screenshot scenes: the Android native half.
//
// The capture scripts launch the app once per scene with `--ei screenshotScene N --ez
// screenshotDark BOOL` (scripts/android-screenshots.sh) and nothing read them, so all six frames
// were the same cold-start screen. This reads the intent extras and hands them to JS.
//
// WHY INTENT EXTRAS AND NOT A DEEP LINK, which would need no native code at all: an extra can only
// be set by whoever LAUNCHES the app - adb, or the capture script. A URL can be sent to the app by
// anything that can open a link, and "show this person a fabricated library on command" is a poor
// thing to ship in an app whose whole promise is that what you see is your own music. The native
// module is the smaller surface, and it matches PearGuard's ScreenshotModule so the suite stays
// consistent.
//
// getConstants(), NOT a promise: the WebView boot script is assembled early, and an async read
// would race it. Constants are resolved when the JS bridge initialises, so the scene is already
// there when the shell needs it.
//
// `dark` is -1 for "not specified" rather than a boolean, so the app can tell "capture in light"
// from "the script said nothing, use the device setting". A plain false could not.

const MODULE_KT = (pkg) => `package ${pkg}

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = ScreenshotModule.NAME)
class ScreenshotModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object { const val NAME = "PearTuneScreenshot" }
    override fun getName() = NAME

    override fun getConstants(): Map<String, Any> {
        var scene = 0
        var dark = -1
        // getCurrentActivity(), not the Kotlin property: the base class exposes it as a Java
        // method Kotlin does not synthesise a property for, so \`currentActivity\` fails to
        // compile. PearGuard's module has this right; deviating from it cost a build.
        val intent: Intent? = getCurrentActivity()?.intent
        if (intent != null) {
            scene = intent.getIntExtra("screenshotScene", 0)
            if (intent.hasExtra("screenshotDark")) {
                dark = if (intent.getBooleanExtra("screenshotDark", false)) 1 else 0
            }
        }
        return mapOf("scene" to scene, "dark" to dark)
    }
}
`

const PACKAGE_KT = (pkg) => `package ${pkg}

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

class ScreenshotPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(ScreenshotModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<out View, out ReactShadowNode<*>>> = emptyList()
}
`

const REGISTER_CALL = 'add(ScreenshotPackage())'

module.exports = { MODULE_KT, PACKAGE_KT, REGISTER_CALL }

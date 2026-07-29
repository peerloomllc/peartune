import XCTest

final class PlaybackProbe: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.peartune")

  func testPlaybackState () {
    app.launch()
    sleep(18)
    // Library -> album tile -> Play
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.26, dy: 0.62)).tap()
    sleep(4)
    let play = app.buttons["Play"]
    if play.waitForExistence(timeout: 15) { play.tap() } else { XCTFail("no Play") }
    for i in 1...5 {
      sleep(5)
      let texts = app.staticTexts.allElementsBoundByIndex.map { $0.label }
      print("=== T\(i*5)s TEXTS: \(texts.filter { $0.contains(":") || $0.lowercased().contains("buffer") || $0.contains("/") }) ===")
    }
    print("=== FULL DUMP ===\n\(app.debugDescription)\n=== END ===")
  }
}

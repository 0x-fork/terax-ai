import Cocoa
import WebKit

final class Delegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate
{
  var window: NSWindow!
  var web: WKWebView!
  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(self, name: "report")
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 650), configuration: config)
    web.navigationDelegate = self
    window = NSWindow(
      contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered,
      defer: false)
    window.title = "Terax Renderer Lab"
    window.contentView = web
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    let url =
      CommandLine.arguments.count > 1
      ? CommandLine.arguments[1]
      : Bundle.main.object(forInfoDictionaryKey: "TeraxLabURL") as? String ?? "about:blank"
    web.load(URLRequest(url: URL(string: url)!))
    DispatchQueue.main.asyncAfter(deadline: .now() + (CommandLine.arguments.count > 2 ? 600 : 120))
    { NSApp.terminate(nil) }
  }
  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    if let text = message.body as? String {
      print(text)
      fflush(stdout)
      if let data = text.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let phase = object["phase"] as? String
      {
        if phase == "done" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.terminate(nil) }
        }
      }
    }
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    print("navigation failed: \(error)")
    fflush(stdout)
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()

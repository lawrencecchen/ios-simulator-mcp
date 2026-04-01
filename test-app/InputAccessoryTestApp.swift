import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = ViewController()
        window?.makeKeyAndVisible()
        return true
    }
}

class ViewController: UIViewController {
    let textField = UITextField()
    let resultLabel = UILabel()
    var tapCount = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        // Title
        let titleLabel = UILabel()
        titleLabel.text = "InputAccessoryView Test"
        titleLabel.font = .boldSystemFont(ofSize: 24)
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.accessibilityIdentifier = "title_label"
        view.addSubview(titleLabel)

        // Text field
        textField.placeholder = "Tap here to show keyboard"
        textField.borderStyle = .roundedRect
        textField.translatesAutoresizingMaskIntoConstraints = false
        textField.accessibilityIdentifier = "test_text_field"
        textField.inputAccessoryView = createAccessoryView()
        view.addSubview(textField)

        // Result label shows what was tapped
        resultLabel.text = "No button tapped yet"
        resultLabel.textAlignment = .center
        resultLabel.numberOfLines = 0
        resultLabel.font = .systemFont(ofSize: 18)
        resultLabel.translatesAutoresizingMaskIntoConstraints = false
        resultLabel.accessibilityIdentifier = "result_label"
        view.addSubview(resultLabel)

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),

            textField.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 30),
            textField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            textField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            textField.heightAnchor.constraint(equalToConstant: 44),

            resultLabel.topAnchor.constraint(equalTo: textField.bottomAnchor, constant: 30),
            resultLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            resultLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }

    func createAccessoryView() -> UIView {
        let toolbar = UIToolbar(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: 44))
        toolbar.accessibilityIdentifier = "input_accessory_toolbar"

        let smallerButton = UIBarButtonItem(
            title: "A-",
            style: .plain,
            target: self,
            action: #selector(smallerTapped)
        )
        smallerButton.accessibilityIdentifier = "btn_font_smaller"
        smallerButton.accessibilityLabel = "Font Smaller"

        let biggerButton = UIBarButtonItem(
            title: "A+",
            style: .plain,
            target: self,
            action: #selector(biggerTapped)
        )
        biggerButton.accessibilityIdentifier = "btn_font_bigger"
        biggerButton.accessibilityLabel = "Font Bigger"

        let pasteButton = UIBarButtonItem(
            title: "Paste",
            style: .plain,
            target: self,
            action: #selector(pasteTapped)
        )
        pasteButton.accessibilityIdentifier = "btn_paste"
        pasteButton.accessibilityLabel = "Paste"

        let flexSpace = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)

        let doneButton = UIBarButtonItem(
            title: "Done",
            style: .done,
            target: self,
            action: #selector(doneTapped)
        )
        doneButton.accessibilityIdentifier = "btn_done"
        doneButton.accessibilityLabel = "Done"

        toolbar.items = [smallerButton, biggerButton, pasteButton, flexSpace, doneButton]
        return toolbar
    }

    @objc func smallerTapped() {
        tapCount += 1
        resultLabel.text = "Tapped: A- (Font Smaller) [#\(tapCount)]"
    }

    @objc func biggerTapped() {
        tapCount += 1
        resultLabel.text = "Tapped: A+ (Font Bigger) [#\(tapCount)]"
    }

    @objc func pasteTapped() {
        tapCount += 1
        resultLabel.text = "Tapped: Paste [#\(tapCount)]"
    }

    @objc func doneTapped() {
        tapCount += 1
        resultLabel.text = "Tapped: Done [#\(tapCount)]"
        textField.resignFirstResponder()
    }
}

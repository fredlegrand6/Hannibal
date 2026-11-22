// Shrinks a photo for Hannibal's eyes (app, share sheet).
import UIKit

extension UIImage {
    /// Same size the desk and web app send: longest side 1568 px, JPEG.
    func forHannibal() -> Data? {
        let maxSide: CGFloat = 1568
        let longest = max(size.width, size.height)
        let scale = longest > maxSide ? maxSide / longest : 1
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
        return img.jpegData(compressionQuality: 0.75)
    }
}

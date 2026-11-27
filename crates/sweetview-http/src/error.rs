//! `webview_error_t` from the C++ fork's `errors.h`.

/// The webview's error codes, with the numeric values of the C++ fork's
/// `webview_error_t`, which applications can observe through the binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum ErrorCode {
    /// `WEBVIEW_ERROR_OK`: success.
    Ok = 0,
    /// `WEBVIEW_ERROR_UNSPECIFIED`: an error with no more specific code.
    Unspecified = -1,
    /// `WEBVIEW_ERROR_INVALID_ARGUMENT`: an argument was refused.
    InvalidArgument = -2,
    /// `WEBVIEW_ERROR_INVALID_STATE`: the webview is not in a state for the call (not created yet, or going away).
    InvalidState = -3,
    /// `WEBVIEW_ERROR_CANCELED`: the operation was cancelled.
    Canceled = -4,
    /// `WEBVIEW_ERROR_MISSING_DEPENDENCY`: something the call needs is not installed.
    MissingDependency = -5,
    /// `WEBVIEW_ERROR_DUPLICATE`: something already exists.
    Duplicate = 1,
    /// `WEBVIEW_ERROR_NOT_FOUND`: something does not exist.
    NotFound = 2,
}

impl ErrorCode {
    /// The numeric value of `webview_error_t`.
    pub fn code(self) -> i32 {
        self as i32
    }

    /// The code for a numeric `webview_error_t`, or `None` for a number that is not one.
    pub fn from_code(code: i32) -> Option<Self> {
        Some(match code {
            0 => Self::Ok,
            -1 => Self::Unspecified,
            -2 => Self::InvalidArgument,
            -3 => Self::InvalidState,
            -4 => Self::Canceled,
            -5 => Self::MissingDependency,
            1 => Self::Duplicate,
            2 => Self::NotFound,
            _ => return None,
        })
    }

    /// True for [`ErrorCode::Ok`].
    pub fn is_ok(self) -> bool {
        self == Self::Ok
    }

    /// `Ok(())` for [`ErrorCode::Ok`], `Err(self)` otherwise.
    pub fn into_result(self) -> Result<(), ErrorCode> {
        if self.is_ok() {
            Ok(())
        } else {
            Err(self)
        }
    }
}

impl From<Result<(), ErrorCode>> for ErrorCode {
    fn from(result: Result<(), ErrorCode>) -> Self {
        match result {
            Ok(()) => Self::Ok,
            Err(code) => code,
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Ok => "WEBVIEW_ERROR_OK",
            Self::Unspecified => "WEBVIEW_ERROR_UNSPECIFIED",
            Self::InvalidArgument => "WEBVIEW_ERROR_INVALID_ARGUMENT",
            Self::InvalidState => "WEBVIEW_ERROR_INVALID_STATE",
            Self::Canceled => "WEBVIEW_ERROR_CANCELED",
            Self::MissingDependency => "WEBVIEW_ERROR_MISSING_DEPENDENCY",
            Self::Duplicate => "WEBVIEW_ERROR_DUPLICATE",
            Self::NotFound => "WEBVIEW_ERROR_NOT_FOUND",
        };
        write!(f, "{name} ({})", self.code())
    }
}

impl std::error::Error for ErrorCode {}

#[cfg(test)]
mod tests {
    use super::ErrorCode;

    // From errors.h: the numeric values are part of the observable surface.
    #[test]
    fn codes_match_webview_error_t() {
        let all = [
            (ErrorCode::Ok, 0),
            (ErrorCode::Unspecified, -1),
            (ErrorCode::InvalidArgument, -2),
            (ErrorCode::InvalidState, -3),
            (ErrorCode::Canceled, -4),
            (ErrorCode::MissingDependency, -5),
            (ErrorCode::Duplicate, 1),
            (ErrorCode::NotFound, 2),
        ];
        for (code, value) in all {
            assert_eq!(code.code(), value);
            assert_eq!(ErrorCode::from_code(value), Some(code));
        }
        assert_eq!(ErrorCode::from_code(3), None);
        assert_eq!(ErrorCode::from(Err(ErrorCode::Duplicate)), ErrorCode::Duplicate);
        assert_eq!(ErrorCode::Ok.into_result(), Ok(()));
    }
}

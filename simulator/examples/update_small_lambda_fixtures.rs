//! Explicit regeneration of CURRENT outcomes; historical input witnesses stay intact.
//! Run with --write to update; --check (the default) verifies without writing.
#[allow(dead_code)]
#[path = "../tests/small_lambda_monotonicity.rs"]
mod grid;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(
        args.is_empty() || args == ["--check"] || args == ["--write"],
        "expected --check or --write"
    );
    let actual = grid::regenerate();
    let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/equilibra-small-lambda-regression.json");
    if args == ["--write"] {
        std::fs::write(
            &target,
            format!("{}\n", serde_json::to_string_pretty(&actual).unwrap()),
        )
        .unwrap();
        println!(
            "Updated {}. Review the diff before accepting the new baseline.",
            target.display()
        );
    } else {
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(
            actual, expected,
            "small-lambda regression drift; inspect before regenerating with --write"
        );
        println!("Small-lambda regression baseline matches.");
    }
}

{
  "targets": [
    {
      "target_name": "filemod",
      "sources": ["filemod.cc"],
      "conditions": [
        ["OS=='linux'", {
          "defines": ["LINUX"],
          "include_dirs": [],
          "libraries": []
        }],
        ["OS=='mac'", {
          "defines": ["MACOS"],
          "include_dirs": [],
          "libraries": []
        }],
        ["OS=='win'", {
          "defines": ["WINDOWS"],
          "include_dirs": [],
          "libraries": []
        }]
      ]
    }
  ]
}
